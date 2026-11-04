const twilio = require("twilio");
const { requireLogin, validateWebhook } = require("../src/security");

function response() {
  const res = {};
  res.set = jest.fn().mockReturnValue(res);
  res.status = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  res.sendStatus = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  process.env.APP_PASSWORD = "test-password";
  process.env.TWILIO_AUTH_TOKEN = "test-token";
  process.env.TWILIO_WEBHOOK_BASE_URL = "https://example.com";
});

test("login rejects anonymous and incorrect credentials", () => {
  for (const auth of ["", `Basic ${Buffer.from("operator:wrong").toString("base64")}`]) {
    const res = response();
    const next = jest.fn();
    requireLogin({ get: () => auth }, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  }
});

test("login accepts the configured operator and fails closed without a password", () => {
  const req = { get: () => `Basic ${Buffer.from("operator:test-password").toString("base64")}` };
  const next = jest.fn();
  requireLogin(req, response(), next);
  expect(next).toHaveBeenCalledTimes(1);
  delete process.env.APP_PASSWORD;
  const res = response();
  requireLogin(req, res, next);
  expect(res.status).toHaveBeenCalledWith(503);
});

test("webhooks accept valid Twilio signatures and reject altered requests", () => {
  const body = { From: "+15550000000", To: "+15551111111" };
  const signature = twilio.getExpectedTwilioSignature("test-token", "https://example.com/voice", body);
  const req = { originalUrl: "/voice", body, get: () => signature };
  const next = jest.fn();
  validateWebhook(req, response(), next);
  expect(next).toHaveBeenCalledTimes(1);
  req.body = { ...body, To: "+15552222222" };
  const res = response();
  validateWebhook(req, res, next);
  expect(res.sendStatus).toHaveBeenCalledWith(403);
});
