jest.mock("../src/users", () => ({
  authenticate: jest.fn(),
  hasEnabledOwner: jest.fn(),
  isCachedLogin: jest.fn(),
}));
const twilio = require("twilio");
const users = require("../src/users");
const {
  requireLogin,
  requireOwner,
  validateWebhook,
  isTwilioWebhook,
  resetLoginLimits,
} = require("../src/security");

function response() {
  const res = {};
  res.set = jest.fn().mockReturnValue(res);
  res.status = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.sendStatus = jest.fn().mockReturnValue(res);
  return res;
}
const basic = (credentials) =>
  `Basic ${Buffer.from(credentials).toString("base64")}`;
const request = (auth, ip = "203.0.113.1") => ({ get: () => auth, ip });
const REALM = 'Basic realm="Iron Wing Dispatching", charset="UTF-8"';
const member = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "dana",
  displayName: "Dana",
  role: "member",
  enabled: true,
  workspaceIds: ["00000000-0000-4000-8000-000000000002"],
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.APP_PASSWORD = "test-password";
  process.env.TWILIO_AUTH_TOKEN = "test-token";
  process.env.TWILIO_WEBHOOK_BASE_URL = "https://example.com";
  users.authenticate.mockResolvedValue(null);
  users.hasEnabledOwner.mockResolvedValue(false);
  users.isCachedLogin.mockReturnValue(false);
  resetLoginLimits();
});

test("login rejects anonymous and incorrect credentials", async () => {
  for (const auth of [
    "",
    basic("operator:wrong"),
    "Bearer x",
    basic("nocolon"),
  ]) {
    const res = response();
    const next = jest.fn();
    await requireLogin(request(auth), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.set).toHaveBeenCalledWith("WWW-Authenticate", REALM);
    expect(next).not.toHaveBeenCalled();
  }
});

test("operator login works only while no owner exists", async () => {
  const req = request(basic("operator:test-password"));
  let res = response();
  let next = jest.fn();
  await requireLogin(req, res, next);
  expect(next).toHaveBeenCalledTimes(1);
  expect(req.user).toEqual({
    id: null,
    username: "operator",
    displayName: "Operator",
    role: "owner",
    bootstrap: true,
    workspaceIds: [],
  });
  expect(res.set).toHaveBeenCalledWith("Cache-Control", "no-store");

  users.hasEnabledOwner.mockResolvedValue(true);
  const later = request(basic("operator:test-password"));
  res = response();
  next = jest.fn();
  await requireLogin(later, res, next);
  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.set).toHaveBeenCalledWith("WWW-Authenticate", REALM);
  expect(next).not.toHaveBeenCalled();
  expect(later.user).toBeUndefined();
});

test("operator login fails closed without APP_PASSWORD, but real users still log in", async () => {
  delete process.env.APP_PASSWORD;
  let res = response();
  const next = jest.fn();
  await requireLogin(request(basic("operator:")), res, next);
  expect(res.status).toHaveBeenCalledWith(503);
  expect(res.send).toHaveBeenCalledWith("App login is not configured.");
  expect(next).not.toHaveBeenCalled();

  users.authenticate.mockResolvedValueOnce({ ...member });
  const req = request(basic("dana:a-long-password-1"));
  res = response();
  await requireLogin(req, res, next);
  expect(next).toHaveBeenCalledTimes(1);
  expect(req.user.username).toBe("dana");
});

test("a user login sets req.user", async () => {
  users.authenticate.mockResolvedValueOnce({ ...member });
  const req = request(basic("dana:a-long-password-1"));
  const res = response();
  const next = jest.fn();
  await requireLogin(req, res, next);
  expect(users.authenticate).toHaveBeenCalledWith("dana", "a-long-password-1");
  expect(next).toHaveBeenCalledTimes(1);
  expect(req.user).toEqual({ ...member, bootstrap: false });
  expect(res.set).toHaveBeenCalledWith("Cache-Control", "no-store");

  // authenticate returns null for a disabled user, an unknown user and a
  // wrong password alike; each gets the same 401 challenge.
  for (const credentials of [
    "disabled:a-long-password-1",
    "nobody:a-long-password-1",
    "dana:the-wrong-password",
  ]) {
    users.authenticate.mockResolvedValueOnce(null);
    const denied = request(basic(credentials));
    const r = response();
    const n = jest.fn();
    await requireLogin(denied, r, n);
    expect(r.status).toHaveBeenCalledWith(401);
    expect(r.set).toHaveBeenCalledWith("WWW-Authenticate", REALM);
    expect(n).not.toHaveBeenCalled();
    expect(denied.user).toBeUndefined();
  }
});

test("passwords containing colons are split at the first colon", async () => {
  users.authenticate.mockResolvedValueOnce({ ...member });
  await requireLogin(
    request(basic("dana:pass:with:colons")),
    response(),
    jest.fn(),
  );
  expect(users.authenticate).toHaveBeenCalledWith("dana", "pass:with:colons");
});

test("a database failure fails closed with 503 and never lets the operator in", async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  users.hasEnabledOwner.mockRejectedValue(new Error("connection refused"));
  for (const auth of [basic("operator:test-password"), basic("dana:x")]) {
    users.authenticate.mockReset();
    users.authenticate.mockRejectedValue(new Error("connection refused"));
    const req = request(auth);
    const res = response();
    const next = jest.fn();
    await requireLogin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.send).toHaveBeenCalledWith("App login is unavailable.");
    expect(next).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  }
  // Even when authenticate succeeds in saying "no such user", an owner check
  // that fails must not open the operator path.
  users.authenticate.mockReset();
  users.authenticate.mockResolvedValue(null);
  const req = request(basic("operator:test-password"));
  const res = response();
  const next = jest.fn();
  await requireLogin(req, res, next);
  expect(res.status).toHaveBeenCalledWith(503);
  expect(next).not.toHaveBeenCalled();
  console.error.mockRestore();
});

test("requireOwner lets owners through and refuses members", () => {
  let next = jest.fn();
  requireOwner({ user: { role: "owner" } }, response(), next);
  expect(next).toHaveBeenCalledTimes(1);
  for (const req of [{ user: member }, {}]) {
    const res = response();
    next = jest.fn();
    requireOwner(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Only an owner can change settings.",
    });
    expect(next).not.toHaveBeenCalled();
  }
});

test("webhook paths still skip login", () => {
  for (const path of [
    "/voice",
    "/sms",
    "/sms-status",
    "/call-status",
    "/announcement/missed",
    "/receptionist/ended",
    "/webhooks/00000000-0000-4000-8000-000000000001/voice",
  ])
    expect(isTwilioWebhook({ method: "POST", path })).toBe(true);
  for (const [method, path] of [
    ["GET", "/voice"],
    ["GET", "/me"],
    ["POST", "/settings/workspaces"],
  ])
    expect(isTwilioWebhook({ method, path })).toBe(false);
});

test("webhooks accept valid Twilio signatures and reject altered requests", () => {
  const body = { From: "+15550000000", To: "+15551111111" };
  const signature = twilio.getExpectedTwilioSignature(
    "test-token",
    "https://example.com/voice",
    body,
  );
  const req = { originalUrl: "/voice", body, get: () => signature };
  const next = jest.fn();
  validateWebhook(req, response(), next);
  expect(next).toHaveBeenCalledTimes(1);
  req.body = { ...body, To: "+15552222222" };
  const res = response();
  validateWebhook(req, res, next);
  expect(res.sendStatus).toHaveBeenCalledWith(403);
});

describe("failed-login limits", () => {
  const LIMITED = "Too many sign-in attempts. Try again in a minute.";
  const attempt = async (credentials, ip) => {
    const req = request(basic(credentials), ip);
    const res = response();
    const next = jest.fn();
    await requireLogin(req, res, next);
    return { req, res, next };
  };
  const fail = async (count, credentials, ip) => {
    for (let i = 0; i < count; i += 1) {
      const { res } = await attempt(credentials, ip);
      expect(res.status).toHaveBeenCalledWith(401);
    }
  };

  test("ten failures from one address answer 429 without hashing or a challenge", async () => {
    await fail(10, "dana:wrong-password-1", "198.51.100.7");
    users.authenticate.mockClear();
    // Another username from the same address is refused too.
    const { res, next } = await attempt("erin:any-password-1", "198.51.100.7");
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.send).toHaveBeenCalledWith(LIMITED);
    expect(res.set).not.toHaveBeenCalledWith("WWW-Authenticate", REALM);
    expect(users.authenticate).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    // A different address is not affected.
    const other = await attempt("erin:any-password-1", "198.51.100.8");
    expect(other.res.status).toHaveBeenCalledWith(401);
  });

  test("ten failures on one username answer 429 from any address", async () => {
    for (let i = 0; i < 10; i += 1)
      await fail(1, "Dana:wrong-password-1", `198.51.100.${i + 10}`);
    users.authenticate.mockClear();
    const { res } = await attempt("dana:wrong-password-1", "198.51.100.99");
    expect(res.status).toHaveBeenCalledWith(429);
    expect(users.authenticate).not.toHaveBeenCalled();
  });

  test("the limit rolls off after a minute", async () => {
    jest.useFakeTimers();
    try {
      await fail(10, "dana:wrong-password-1", "198.51.100.7");
      expect(
        (await attempt("dana:wrong-password-1", "198.51.100.7")).res.status,
      ).toHaveBeenCalledWith(429);
      jest.advanceTimersByTime(61 * 1000);
      expect(
        (await attempt("dana:wrong-password-1", "198.51.100.7")).res.status,
      ).toHaveBeenCalledWith(401);
    } finally {
      jest.useRealTimers();
    }
  });

  test("successful logins do not count", async () => {
    users.authenticate.mockResolvedValue({ ...member });
    for (let i = 0; i < 20; i += 1) {
      const { next } = await attempt("dana:a-long-password-1", "198.51.100.7");
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  test("a signed-in person's cached login still passes while their address is limited", async () => {
    await fail(10, "mallory:wrong-password-1", "198.51.100.7");
    users.isCachedLogin.mockImplementation(
      (username, password) =>
        username === "dana" && password === "a-long-password-1",
    );
    users.authenticate.mockResolvedValueOnce({ ...member });
    const { req, next } = await attempt(
      "dana:a-long-password-1",
      "198.51.100.7",
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user.username).toBe("dana");
  });

  test("a busy login answers 503 and is not counted as a failure", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    const busy = Object.assign(new Error("App login is busy. Try again."), {
      code: "LOGIN_BUSY",
    });
    users.authenticate.mockRejectedValue(busy);
    for (let i = 0; i < 12; i += 1) {
      const { res } = await attempt("dana:wrong-password-1", "198.51.100.7");
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.send).toHaveBeenCalledWith("App login is busy. Try again.");
    }
    console.error.mockRestore();
  });

  test("memory stays bounded: the oldest address is dropped past the cap", () => {
    const { createLoginLimiter } = require("../src/loginLimiter");
    const limiter = createLoginLimiter({ max: 1, maxKeys: 3 });
    for (const key of ["a", "b", "c", "d"]) limiter.fail([key]);
    expect(limiter.size()).toBe(3);
    expect(limiter.blocked(["a"])).toBe(false);
    expect(limiter.blocked(["d"])).toBe(true);
  });
});
