jest.mock("../src/users", () => ({
  authenticate: jest.fn(),
  hasEnabledOwner: jest.fn(),
}));
const twilio = require("twilio");
const users = require("../src/users");
const {
  requireLogin,
  requireOwner,
  validateWebhook,
  isTwilioWebhook,
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
const request = (auth) => ({ get: () => auth });
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
