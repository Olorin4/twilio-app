jest.mock("../src/db", () => ({ query: jest.fn() }));
jest.mock("../src/credentialEncryption", () => ({
  decryptCredentials: jest.fn(),
}));
jest.mock("twilio", () => jest.fn(() => ({ client: "fake" })));
jest.mock("../src/token", () => ({
  accountSid: "AClegacy",
  authToken: "legacy-auth",
  apiKey: "legacy-key",
  apiSecret: "legacy-secret",
  appSid: "legacy-app",
  callerId: "+15550000000",
  client: {},
}));
const pool = require("../src/db");
const { decryptCredentials } = require("../src/credentialEncryption");
const { getProvider } = require("../src/providerContext");
const iron = "00000000-0000-4000-8000-000000000001",
  other = "00000000-0000-4000-8000-000000000002",
  number = "00000000-0000-4000-8000-000000000003";
beforeEach(() => jest.clearAllMocks());
test("retains the legacy Iron Wing provider if no saved number is active", async () => {
  pool.query.mockResolvedValueOnce({ rows: [] });
  const result = await getProvider(iron);
  expect(result.legacy).toBe(true);
  expect(result.phoneNumber).toBe("+15550000000");
});
test("does not fall back to Iron Wing for another workspace or unknown selected number", async () => {
  pool.query.mockResolvedValue({ rows: [] });
  await expect(getProvider(other)).rejects.toThrow("No phone number");
  await expect(getProvider(iron, number)).rejects.toThrow("No phone number");
});
test("only resolves a saved provider returned for the requested workspace", async () => {
  pool.query.mockResolvedValueOnce({
    rows: [
      {
        id: number,
        workspace_id: other,
        account_sid: "ACtest",
        number_id: number,
        phone_number: "+15550000001",
        voice_enabled: true,
        sms_enabled: false,
        encrypted_credentials: {},
      },
    ],
  });
  decryptCredentials.mockReturnValue({
    authToken: "auth",
    apiKeySid: "key",
    apiKeySecret: "secret",
    twimlAppSid: "app",
  });
  const result = await getProvider(other, number);
  expect(pool.query.mock.calls[0][1]).toEqual([other, number]);
  expect(result.workspaceId).toBe(other);
  expect(result.smsEnabled).toBe(false);
});
