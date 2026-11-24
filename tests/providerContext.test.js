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

test("providers carry the number's handler", async () => {
  const agent = "00000000-0000-4000-8000-0000000000c1";
  pool.query.mockResolvedValueOnce({
    rows: [
      {
        id: number,
        workspace_id: other,
        account_sid: "ACtest",
        number_id: number,
        phone_number: "+15550000001",
        voice_enabled: true,
        sms_enabled: true,
        handler: "ai_agent",
        agent_profile_id: agent,
        label: "Main",
        observe_hours: false,
        encrypted_credentials: {},
      },
    ],
  });
  decryptCredentials.mockReturnValue({ authToken: "auth" });
  const result = await getProvider(other, number);
  expect(result).toMatchObject({
    handler: "ai_agent",
    agentProfileId: agent,
    numberLabel: "Main",
    observeHours: false,
  });
});
test("the legacy provider reports the legacy handler", async () => {
  pool.query.mockResolvedValueOnce({ rows: [] });
  expect(await getProvider(iron)).toMatchObject({
    handler: "legacy",
    agentProfileId: null,
    numberLabel: null,
    observeHours: true,
  });
});

describe("checkNumberSchema", () => {
  const { checkNumberSchema } = require("../src/providerContext");
  let error;
  beforeEach(() => {
    error = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => error.mockRestore());

  test("logs loudly when connection_numbers.handler is missing (migration 013 not run)", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await expect(checkNumberSchema()).resolves.toBe(false);
    expect(pool.query.mock.calls[0][0]).toMatch(/information_schema\.columns/);
    expect(pool.query.mock.calls[0][1]).toEqual([
      "connection_numbers",
      "handler",
    ]);
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/migrate:agent-profiles/),
    );
  });

  test("stays quiet when the column exists", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });
    await expect(checkNumberSchema()).resolves.toBe(true);
    expect(error).not.toHaveBeenCalled();
  });

  test("never throws when the database is unreachable", async () => {
    pool.query.mockRejectedValueOnce(new Error("connection refused"));
    await expect(checkNumberSchema()).resolves.toBeNull();
    expect(error).toHaveBeenCalled();
  });
});

describe("checkUsersSchema", () => {
  const { checkUsersSchema } = require("../src/providerContext");
  const MESSAGE = "DATABASE NOT MIGRATED: run npm run migrate:users";
  let error;
  let warn;
  let saved;
  beforeEach(() => {
    pool.query.mockReset();
    error = jest.spyOn(console, "error").mockImplementation(() => {});
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    saved = process.env.TWILIO_IDENTITY;
    process.env.TWILIO_IDENTITY = "iron_wing_desk";
  });
  afterEach(() => {
    error.mockRestore();
    warn.mockRestore();
    if (saved === undefined) delete process.env.TWILIO_IDENTITY;
    else process.env.TWILIO_IDENTITY = saved;
  });
  // Answers whether app_users and connection_numbers.personal exist.
  const schema = ({ users, personal }) =>
    pool.query.mockResolvedValueOnce({
      rows: [{ users_table: users, personal_column: personal }],
    });

  test("logs loudly when app_users is missing (migration 014 not run)", async () => {
    schema({ users: false, personal: true });
    await expect(checkUsersSchema()).resolves.toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(MESSAGE));
  });

  test("logs loudly when connection_numbers.personal is missing", async () => {
    schema({ users: true, personal: false });
    await expect(checkUsersSchema()).resolves.toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(MESSAGE));
  });

  test("stays quiet when both exist", async () => {
    schema({ users: true, personal: true });
    await expect(checkUsersSchema()).resolves.toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  test("warns when TWILIO_IDENTITY is unset, which production needs after cutover", async () => {
    delete process.env.TWILIO_IDENTITY;
    schema({ users: true, personal: true });
    await expect(checkUsersSchema()).resolves.toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/TWILIO_IDENTITY is not set/),
    );
  });

  test("never throws when the database is unreachable", async () => {
    pool.query.mockRejectedValueOnce(new Error("connection refused"));
    await expect(checkUsersSchema()).resolves.toBeNull();
    expect(error).toHaveBeenCalled();
  });
});

describe("checkSignInLimits", () => {
  const { checkSignInLimits } = require("../src/providerContext");
  const MESSAGE =
    "Per-client sign-in limits are off: set TRUST_PROXY to the number of proxies in front of the app. Only the per-username cap applies.";
  let warn;
  beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  test("warns when TRUST_PROXY is unset", () => {
    expect(checkSignInLimits(false)).toBe(false);
    expect(warn).toHaveBeenCalledWith(MESSAGE);
    warn.mockClear();
    expect(checkSignInLimits(0)).toBe(false);
    expect(warn).toHaveBeenCalledWith(MESSAGE);
  });

  test("stays quiet when trust proxy is set", () => {
    expect(checkSignInLimits(1)).toBe(true);
    expect(checkSignInLimits("loopback, 172.16.0.0/12")).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});
