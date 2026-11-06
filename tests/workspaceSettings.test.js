jest.mock("../src/workspaceConnections", () => ({}));
jest.mock("../src/twilioConnectionValidation", () => ({}));
const { requireSettingsWrite } = require("../src/workspaceSettings");
const originalBase = process.env.TWILIO_WEBHOOK_BASE_URL;
const originalOrigin = process.env.APP_ORIGIN;
const response = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn(),
});
beforeEach(() => {
  process.env.TWILIO_WEBHOOK_BASE_URL = "https://example.com";
  delete process.env.APP_ORIGIN;
});
afterAll(() => {
  if (originalBase === undefined) delete process.env.TWILIO_WEBHOOK_BASE_URL;
  else process.env.TWILIO_WEBHOOK_BASE_URL = originalBase;
  if (originalOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = originalOrigin;
});
test("accepts same-origin JSON settings writes", () => {
  const next = jest.fn();
  requireSettingsWrite(
    { is: () => true, get: () => "https://example.com" },
    response(),
    next,
  );
  expect(next).toHaveBeenCalled();
});
test("rejects untrusted or absent origins and non-JSON requests", () => {
  for (const origin of [undefined, "https://attacker.example"]) {
    const res = response(),
      next = jest.fn();
    requireSettingsWrite({ is: () => true, get: () => origin }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  }
  const res = response();
  requireSettingsWrite({ is: () => false }, res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(415);
});
