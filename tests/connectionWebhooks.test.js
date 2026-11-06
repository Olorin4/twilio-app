jest.mock("../src/db", () => ({ query: jest.fn() }));
jest.mock("../src/credentialEncryption", () => ({
  decryptCredentials: jest.fn(),
}));
const twilio = require("twilio");
const pool = require("../src/db");
const { decryptCredentials } = require("../src/credentialEncryption");
const { authenticateConnectionWebhook } = require("../src/connectionWebhooks");
const id = "00000000-0000-4000-8000-000000000001",
  accountSid = "AC" + "1".repeat(32),
  token = "test-token";
const originalBase = process.env.TWILIO_WEBHOOK_BASE_URL;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.TWILIO_WEBHOOK_BASE_URL = "https://example.test";
  pool.query.mockResolvedValue({
    rows: [
      {
        id,
        workspace_id: id,
        account_sid: accountSid,
        encrypted_credentials: {},
      },
    ],
  });
  decryptCredentials.mockReturnValue({ authToken: token });
});
afterAll(() => {
  if (originalBase === undefined) delete process.env.TWILIO_WEBHOOK_BASE_URL;
  else process.env.TWILIO_WEBHOOK_BASE_URL = originalBase;
});
function request(body = { AccountSid: accountSid }) {
  const originalUrl = `/webhooks/${id}/sms`;
  const signature = twilio.getExpectedTwilioSignature(
    token,
    `https://example.test${originalUrl}`,
    body,
  );
  return {
    params: { connectionId: id },
    originalUrl,
    body,
    get: () => signature,
  };
}
test("accepts only a matching account and valid signature and never attaches credentials", async () => {
  const req = request(),
    res = { sendStatus: jest.fn() },
    next = jest.fn();
  await authenticateConnectionWebhook(req, res, next);
  expect(next).toHaveBeenCalled();
  expect(req.providerConnection).toEqual({ id, workspaceId: id, accountSid });
  expect(JSON.stringify(req.providerConnection)).not.toContain(token);
});
test("rejects a different account, invalid signature, and unknown connection", async () => {
  const next = jest.fn();
  let req = request({ AccountSid: "AC" + "9".repeat(32) }),
    res = { sendStatus: jest.fn() };
  await authenticateConnectionWebhook(req, res, next);
  expect(res.sendStatus).toHaveBeenCalledWith(403);
  req = request();
  req.get = () => "invalid";
  res = { sendStatus: jest.fn() };
  await authenticateConnectionWebhook(req, res, next);
  expect(res.sendStatus).toHaveBeenCalledWith(403);
  pool.query.mockResolvedValueOnce({ rows: [] });
  req = request();
  res = { sendStatus: jest.fn() };
  await authenticateConnectionWebhook(req, res, next);
  expect(res.sendStatus).toHaveBeenCalledWith(403);
  expect(next).not.toHaveBeenCalled();
});
