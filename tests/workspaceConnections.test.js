jest.mock("../src/db", () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock("../src/twilioConnectionValidation", () => ({}));
const crypto = require("crypto");
const pool = require("../src/db");
const {
  createConnection,
  listConnections,
  updateConnectionCredentials,
  listWorkspaces,
  listVoiceTargets,
  renameWorkspace,
  archiveWorkspace,
} = require("../src/workspaceConnections");
const { encryptCredentials } = require("../src/credentialEncryption");
const workspaceId = "00000000-0000-4000-8000-000000000001";
const credentials = {
  accountSid: "AC" + "1".repeat(32),
  authToken: "private-auth",
  apiKeySid: "SK" + "2".repeat(32),
  apiKeySecret: "private-secret",
  twimlAppSid: "AP" + "3".repeat(32),
};
const owned = [
  { sid: "PN1", phoneNumber: "+15550000001", voice: true, sms: true },
  { sid: "PN2", phoneNumber: "+15550000002", voice: true, sms: false },
];
const originalKey = process.env.WORKSPACE_CREDENTIALS_KEY;
const originalCaller = process.env.TWILIO_CALLER_ID;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.WORKSPACE_CREDENTIALS_KEY = crypto
    .randomBytes(32)
    .toString("base64");
});
afterAll(() => {
  if (originalKey === undefined) delete process.env.WORKSPACE_CREDENTIALS_KEY;
  else process.env.WORKSPACE_CREDENTIALS_KEY = originalKey;
  if (originalCaller === undefined) delete process.env.TWILIO_CALLER_ID;
  else process.env.TWILIO_CALLER_ID = originalCaller;
});

test("saves only selected owned numbers and returns no secrets", async () => {
  const query = jest.fn().mockResolvedValue({ rows: [] });
  query
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({ rows: [{ id: workspaceId }] });
  const client = { query, release: jest.fn() };
  pool.connect.mockResolvedValueOnce(client);
  const result = await createConnection(workspaceId, "Dispatch", credentials, {
    selectedNumberSids: ["PN2"],
    validate: async () => ({ numbers: owned }),
  });
  expect(result.numbers.map((number) => number.sid)).toEqual(["PN2"]);
  expect(JSON.stringify(result)).not.toContain("private-");
  const inserted = query.mock.calls.find(([sql]) =>
    sql.includes("INSERT INTO provider_connections"),
  );
  expect(inserted[1][4]).not.toContain("private-");
  expect(
    query.mock.calls.filter(([sql]) =>
      sql.includes("INSERT INTO connection_numbers"),
    ),
  ).toHaveLength(1);
  expect(query).toHaveBeenLastCalledWith("COMMIT");
  expect(client.release).toHaveBeenCalled();
});
test("unowned numbers are rejected before database mutation", async () => {
  await expect(
    createConnection(workspaceId, "Dispatch", credentials, {
      selectedNumberSids: ["PN3"],
      validate: async () => ({ numbers: owned }),
    }),
  ).rejects.toThrow("does not belong");
  expect(pool.connect).not.toHaveBeenCalled();
});
test("the existing Iron Wing number cannot be claimed by another workspace", async () => {
  process.env.TWILIO_CALLER_ID = "+15550000001";
  await expect(
    createConnection(
      "00000000-0000-4000-8000-000000000002",
      "Other",
      credentials,
      {
        selectedNumberSids: ["PN1"],
        validate: async () => ({ numbers: owned }),
      },
    ),
  ).rejects.toThrow("current Iron Wing number");
  expect(pool.connect).not.toHaveBeenCalled();
  if (originalCaller === undefined) delete process.env.TWILIO_CALLER_ID;
  else process.env.TWILIO_CALLER_ID = originalCaller;
});
test("rejects overlapping ownership and rolls back", async () => {
  const query = jest.fn().mockResolvedValue({ rows: [] });
  query
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({ rows: [{ id: workspaceId }] })
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({ rows: [{}] });
  const client = { query, release: jest.fn() };
  pool.connect.mockResolvedValueOnce(client);
  await expect(
    createConnection(workspaceId, "Dispatch", credentials, {
      selectedNumberSids: ["PN1"],
      validate: async () => ({ numbers: owned }),
    }),
  ).rejects.toThrow("already connected");
  expect(query).toHaveBeenLastCalledWith("ROLLBACK");
  expect(client.release).toHaveBeenCalled();
});
test("list response queries never request the credential envelope", async () => {
  pool.query.mockResolvedValue({ rows: [] });
  expect(await listConnections(workspaceId)).toEqual([]);
  expect(pool.query.mock.calls[0][0]).not.toContain("encrypted_credentials");
});
test("credential rotation rejects a changed account before mutation", async () => {
  const connectionId = "00000000-0000-4000-8000-000000000003";
  pool.query.mockResolvedValueOnce({
    rows: [
      {
        id: connectionId,
        account_sid: credentials.accountSid,
        twiml_app_sid: credentials.twimlAppSid,
        encrypted_credentials: {},
      },
    ],
  });
  await expect(
    updateConnectionCredentials(workspaceId, connectionId, {
      ...credentials,
      accountSid: "AC" + "9".repeat(32),
    }),
  ).rejects.toThrow("add a new connection");
  expect(pool.connect).not.toHaveBeenCalled();
});
test("credential rotation preserves assigned numbers and returns no secrets", async () => {
  const connectionId = "00000000-0000-4000-8000-000000000003";
  const oldEnvelope = encryptCredentials(connectionId, { authToken: "old" });
  pool.query
    .mockResolvedValueOnce({
      rows: [
        {
          id: connectionId,
          account_sid: credentials.accountSid,
          twiml_app_sid: credentials.twimlAppSid,
          encrypted_credentials: oldEnvelope,
        },
      ],
    })
    .mockResolvedValueOnce({
      rows: [{ provider_number_sid: "PN1", phone_number: "+15550000001" }],
    });
  const query = jest.fn().mockResolvedValue({ rows: [] });
  query
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({ rows: [{ id: connectionId }] });
  const client = { query, release: jest.fn() };
  pool.connect.mockResolvedValueOnce(client);
  const result = await updateConnectionCredentials(
    workspaceId,
    connectionId,
    credentials,
    { validate: async () => ({ numbers: owned }) },
  );
  expect(result).toEqual({ id: connectionId, updated: true });
  expect(JSON.stringify(result)).not.toContain("private-");
  expect(query).toHaveBeenLastCalledWith("COMMIT");
});

const otherId = "00000000-0000-4000-8000-000000000002";
test("renaming trims the name and only touches an active workspace", async () => {
  pool.query.mockResolvedValueOnce({
    rows: [{ id: otherId, name: "Dispatch East" }],
  });
  const result = await renameWorkspace(otherId, "  Dispatch East ");
  expect(result.name).toBe("Dispatch East");
  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toContain("UPDATE workspaces SET name");
  expect(sql).toContain("archived_at IS NULL");
  expect(params).toEqual([otherId, "Dispatch East"]);
});
test("renaming rejects bad names, bad ids and missing workspaces", async () => {
  await expect(renameWorkspace(otherId, "   ")).rejects.toThrow(
    "Enter a workspace name",
  );
  await expect(renameWorkspace(otherId, "x".repeat(121))).rejects.toThrow(
    "Enter a workspace name",
  );
  await expect(renameWorkspace("nope", "Name")).rejects.toThrow(
    "Invalid workspace.",
  );
  expect(pool.query).not.toHaveBeenCalled();
  pool.query.mockResolvedValueOnce({ rows: [] });
  await expect(renameWorkspace(otherId, "Name")).rejects.toThrow(
    "Workspace does not exist.",
  );
});
test("archiving soft-deletes by timestamp and never deletes rows", async () => {
  pool.query.mockResolvedValueOnce({ rows: [{ id: otherId }] });
  await archiveWorkspace(otherId);
  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toContain("SET archived_at = now()");
  expect(sql).toContain("archived_at IS NULL");
  expect(sql).not.toContain("DELETE");
  expect(params).toEqual([otherId]);
});
test("the Iron Wing workspace cannot be archived", async () => {
  await expect(archiveWorkspace(workspaceId)).rejects.toThrow(
    "The Iron Wing workspace cannot be archived.",
  );
  expect(pool.query).not.toHaveBeenCalled();
});
test("archiving rejects bad ids and missing or already archived workspaces", async () => {
  await expect(archiveWorkspace("nope")).rejects.toThrow("Invalid workspace.");
  pool.query.mockResolvedValueOnce({ rows: [] });
  await expect(archiveWorkspace(otherId)).rejects.toThrow(
    "Workspace does not exist.",
  );
});
test("archived workspaces are left out of lists and voice targets", async () => {
  pool.query.mockResolvedValue({ rows: [] });
  await listWorkspaces();
  await listVoiceTargets();
  expect(pool.query.mock.calls[0][0]).toContain("w.archived_at IS NULL");
  expect(pool.query.mock.calls[1][0]).toContain("w.archived_at IS NULL");
});
