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
  trustProxySetting,
  applyTrustProxy,
  limitKeys,
} = require("../src/security");
const express = require("express");

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
// `trust` is the app's "trust proxy" setting; production sets TRUST_PROXY=1.
const request = (auth, ip = "203.0.113.1", trust = 1) => ({
  get: () => auth,
  ip,
  app: { get: (name) => (name === "trust proxy" ? trust : undefined) },
});
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

describe("TRUST_PROXY", () => {
  test("unset or empty is off, a whole number is a hop count, anything else passes through", () => {
    expect(trustProxySetting(undefined)).toBe(false);
    expect(trustProxySetting("")).toBe(false);
    expect(trustProxySetting("  ")).toBe(false);
    expect(trustProxySetting("1")).toBe(1);
    expect(trustProxySetting("2")).toBe(2);
    expect(trustProxySetting("loopback, 172.16.0.0/12")).toBe(
      "loopback, 172.16.0.0/12",
    );
  });

  test("false, off, no and 0 in any case are off", () => {
    for (const value of [
      "false",
      "FALSE",
      "off",
      "Off",
      "no",
      "NO",
      "0",
      " 0 ",
    ])
      expect(trustProxySetting(value)).toBe(false);
  });

  // Express would trust every hop, so anyone could forge X-Forwarded-For.
  test("true, yes and on are refused", () => {
    for (const value of ["true", "TRUE", "yes", "on", " On "])
      expect(() => trustProxySetting(value)).toThrow(
        "TRUST_PROXY=true would let clients forge their address; set it to the number of proxies in front of the app (usually 1).",
      );
  });

  test("a value Express rejects is named instead of an opaque stack", () => {
    expect(() => trustProxySetting("not-an-address")).toThrow(
      'TRUST_PROXY "not-an-address" is not valid',
    );
    expect(() => trustProxySetting("10.0.0.0/99")).toThrow(
      'TRUST_PROXY "10.0.0.0/99" is not valid',
    );
  });

  describe("applyTrustProxy at startup", () => {
    let error;
    let exit;
    beforeEach(() => {
      error = jest.spyOn(console, "error").mockImplementation(() => {});
      exit = jest.spyOn(process, "exit").mockImplementation(() => {});
    });
    afterEach(() => {
      error.mockRestore();
      exit.mockRestore();
    });

    test("sets the app's trust proxy for good values", () => {
      for (const [value, expected] of [
        [undefined, false],
        ["off", false],
        ["1", 1],
        ["loopback", "loopback"],
      ]) {
        const app = express();
        applyTrustProxy(app, value);
        expect(app.get("trust proxy")).toBe(expected);
      }
      expect(exit).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });

    test("logs the reason and exits non-zero for true and invalid values", () => {
      for (const [value, message] of [
        ["true", "TRUST_PROXY=true would let clients forge their address"],
        ["not-an-address", 'TRUST_PROXY "not-an-address" is not valid'],
      ]) {
        error.mockClear();
        exit.mockClear();
        applyTrustProxy(express(), value);
        expect(error).toHaveBeenCalledWith(expect.stringContaining(message));
        expect(exit).toHaveBeenCalledWith(1);
      }
    });
  });
});

describe("failed-login limits", () => {
  const LIMITED = "Too many sign-in attempts. Try again in a minute.";
  const attempt = async (credentials, ip, trust) => {
    const req = request(basic(credentials), ip, trust);
    const res = response();
    const next = jest.fn();
    await requireLogin(req, res, next);
    return { req, res, next };
  };
  const fail = async (count, credentials, ip, trust) => {
    for (let i = 0; i < count; i += 1) {
      const { res } = await attempt(credentials, ip, trust);
      expect(res.status).toHaveBeenCalledWith(401);
    }
  };
  const usernames = (count) =>
    Array.from({ length: count }, (_, i) => `user${i}:wrong-password-1`);

  // Without trust proxy every client is the edge nginx's address, so a
  // per-client limit would lock everyone out together.
  test("per-client limits are off without TRUST_PROXY", async () => {
    for (const trust of [false, 0])
      for (let i = 0; i < 50; i += 1) {
        const { res } = await attempt(
          "dana:wrong-password-1",
          "10.0.0.2",
          trust,
        );
        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.status).not.toHaveBeenCalledWith(429);
      }
  });

  test("with TRUST_PROXY, one address is limited after 30 bad logins and others are not", async () => {
    for (const credentials of usernames(30))
      await fail(1, credentials, "198.51.100.7");
    users.authenticate.mockClear();
    // Another username from the same address is refused too.
    const { res, next } = await attempt("erin:any-password-1", "198.51.100.7");
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.send).toHaveBeenCalledWith(LIMITED);
    expect(res.set).toHaveBeenCalledWith("Retry-After", "60");
    expect(res.set).not.toHaveBeenCalledWith("WWW-Authenticate", REALM);
    expect(users.authenticate).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    // A different address is not affected.
    const other = await attempt("erin:any-password-1", "198.51.100.8");
    expect(other.res.status).toHaveBeenCalledWith(401);
  });

  test("29 bad logins from one address with different usernames are not limited", async () => {
    for (const credentials of usernames(29))
      await fail(1, credentials, "198.51.100.7");
    await fail(1, "erin:any-password-1", "198.51.100.7");
  });

  test("a stranger cannot lock out a username", async () => {
    await fail(10, "nick:wrong-password-1", "198.51.100.7");
    expect(
      (await attempt("nick:wrong-password-1", "198.51.100.7")).res.status,
    ).toHaveBeenCalledWith(429);
    users.authenticate.mockResolvedValueOnce({
      ...member,
      username: "nick",
      role: "owner",
    });
    const { req, next } = await attempt(
      "nick:the-right-password",
      "198.51.100.200",
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user.username).toBe("nick");
  });

  test("the same address and username is limited after 10", async () => {
    await fail(9, "Dana:wrong-password-1", "198.51.100.7");
    await fail(1, " dana :wrong-password-2", "198.51.100.7");
    users.authenticate.mockClear();
    const { res } = await attempt("DANA:wrong-password-3", "198.51.100.7");
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.send).toHaveBeenCalledWith(LIMITED);
    expect(users.authenticate).not.toHaveBeenCalled();
    // The same address can still try another username.
    await fail(1, "erin:any-password-1", "198.51.100.7");
  });

  // Distributed guessing on one account is capped loosely in both modes.
  for (const trust of [1, false])
    test(`100 failures on one username from many addresses limit it (trust proxy ${trust})`, async () => {
      for (let i = 0; i < 99; i += 1)
        await fail(
          1,
          "Nick:wrong-password-1",
          `10.1.${i >> 8}.${i & 255}`,
          trust,
        );
      // 99 is not limited.
      await fail(1, "nick:wrong-password-2", "10.2.0.1", trust);
      users.authenticate.mockClear();
      const { res } = await attempt(
        "nick:the-right-password",
        "10.3.0.1",
        trust,
      );
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.send).toHaveBeenCalledWith(LIMITED);
      expect(users.authenticate).not.toHaveBeenCalled();
      // Other usernames are not affected.
      await fail(1, "erin:any-password-1", "10.3.0.1", trust);
      // A signed-in (cached) nick still gets in.
      users.isCachedLogin.mockImplementation(
        (username, password) =>
          username === "nick" && password === "the-right-password",
      );
      users.authenticate.mockResolvedValueOnce({ ...member, username: "nick" });
      const cached = await attempt(
        "nick:the-right-password",
        "10.3.0.1",
        trust,
      );
      expect(cached.next).toHaveBeenCalledTimes(1);
    });

  test("limiter keys carry a sha256 of the folded username, never the raw string", () => {
    const hash = require("crypto")
      .createHash("sha256")
      .update("nick")
      .digest("hex");
    const long = "x".repeat(5000);
    expect(limitKeys(request("", "198.51.100.7", 1), " Nick ")).toEqual([
      "ip:198.51.100.7",
      `ipuser:198.51.100.7|${hash}`,
      `user:${hash}`,
    ]);
    expect(limitKeys(request("", "198.51.100.7", false), "NICK")).toEqual([
      `user:${hash}`,
    ]);
    for (const key of limitKeys(request("", "198.51.100.7", 1), long)) {
      expect(key).not.toContain("xxxx");
      expect(key.length).toBeLessThan(120);
    }
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
    for (let i = 0; i < 40; i += 1) {
      const { next } = await attempt("dana:a-long-password-1", "198.51.100.7");
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  test("a signed-in person's cached login still passes while their address is limited", async () => {
    for (const credentials of usernames(30))
      await fail(1, credentials, "198.51.100.7");
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

  test("each key's limit comes from its prefix", () => {
    const { createLoginLimiter } = require("../src/loginLimiter");
    const limiter = createLoginLimiter({ limits: { ip: 3, ipuser: 2 } });
    limiter.fail(["ip:a", "ipuser:a|x"]);
    limiter.fail(["ip:a", "ipuser:a|x"]);
    expect(limiter.blocked(["ipuser:a|x"])).toBe(true);
    expect(limiter.blocked(["ip:a"])).toBe(false);
    limiter.fail(["ip:a", "ipuser:a|y"]);
    expect(limiter.blocked(["ip:a"])).toBe(true);
    expect(limiter.blocked(["ipuser:a|y"])).toBe(false);
  });

  test("memory stays bounded: the oldest address is dropped past the cap", () => {
    const { createLoginLimiter } = require("../src/loginLimiter");
    const limiter = createLoginLimiter({ limits: { ip: 1 }, maxKeys: 3 });
    for (const key of ["ip:a", "ip:b", "ip:c", "ip:d"]) limiter.fail([key]);
    expect(limiter.size()).toBe(3);
    expect(limiter.blocked(["ip:a"])).toBe(false);
    expect(limiter.blocked(["ip:d"])).toBe(true);
  });
});
