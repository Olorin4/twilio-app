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
  releaseNumber,
  moveNumber,
  listAllConnections,
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
  expect(sql).not.toContain("DELETE FROM workspaces");
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

test("archiving also frees the workspace's numbers in the same statement", async () => {
  pool.query.mockResolvedValueOnce({ rows: [{ id: otherId }] });
  await archiveWorkspace(otherId);
  expect(pool.query).toHaveBeenCalledTimes(1);
  const sql = pool.query.mock.calls[0][0];
  expect(sql).toContain("DELETE FROM workspace_active_numbers");
  expect(sql).toContain("DELETE FROM connection_numbers");
});

const numberId = "00000000-0000-4000-8000-0000000000a1";
const sourceConnection = "00000000-0000-4000-8000-0000000000b1";
const targetConnection = "00000000-0000-4000-8000-0000000000b2";
function fakeClient(handlers) {
  const query = jest.fn(async (sql) => {
    for (const [fragment, result] of handlers)
      if (sql.includes(fragment)) return result;
    return { rows: [] };
  });
  const client = { query, release: jest.fn() };
  pool.connect.mockResolvedValueOnce(client);
  return client;
}
const ran = (client, fragment) =>
  client.query.mock.calls.some(([sql]) => sql.includes(fragment));

test("releasing removes the number and its active selection atomically", async () => {
  const client = fakeClient([
    [
      "DELETE FROM connection_numbers",
      { rows: [{ phone_number: "+15550000009" }] },
    ],
  ]);
  const result = await releaseNumber(otherId, numberId);
  expect(result).toEqual({ released: true, phone_number: "+15550000009" });
  expect(client.query).toHaveBeenNthCalledWith(1, "BEGIN");
  expect(ran(client, "DELETE FROM workspace_active_numbers")).toBe(true);
  expect(client.query).toHaveBeenLastCalledWith("COMMIT");
  expect(client.release).toHaveBeenCalled();
});
test("releasing a number from another workspace changes nothing", async () => {
  const client = fakeClient([]);
  await expect(releaseNumber(otherId, numberId)).rejects.toThrow(
    "Number does not belong to this workspace.",
  );
  expect(ran(client, "COMMIT")).toBe(false);
  expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
  expect(client.release).toHaveBeenCalled();
});
test("releasing rejects malformed ids before touching the database", async () => {
  await expect(releaseNumber("nope", numberId)).rejects.toThrow(
    "Invalid workspace or number.",
  );
  await expect(releaseNumber(otherId, "nope")).rejects.toThrow(
    "Invalid workspace or number.",
  );
  expect(pool.connect).not.toHaveBeenCalled();
});

const moveHandlers = (overrides = {}) => [
  [
    "FROM connection_numbers n",
    {
      rows: [
        {
          id: numberId,
          phone_number: "+15550000009",
          connection_id: sourceConnection,
          account_sid: "AC" + "1".repeat(32),
        },
      ],
    },
  ],
  [
    "FROM provider_connections c JOIN workspaces",
    {
      rows: [
        {
          id: targetConnection,
          workspace_id: otherId,
          account_sid: overrides.targetAccount || "AC" + "1".repeat(32),
        },
      ],
    },
  ],
  ["UPDATE connection_numbers", { rows: [{ id: numberId }] }],
];
test("moving re-points the number to a connection on the same Twilio account", async () => {
  const client = fakeClient(moveHandlers());
  const result = await moveNumber(workspaceId, numberId, targetConnection);
  expect(result).toMatchObject({
    moved: true,
    phone_number: "+15550000009",
    workspace_id: otherId,
    connection_id: targetConnection,
  });
  expect(ran(client, "DELETE FROM workspace_active_numbers")).toBe(true);
  const update = client.query.mock.calls.find(([sql]) =>
    sql.includes("UPDATE connection_numbers"),
  );
  expect(update[1]).toEqual([numberId, targetConnection]);
  expect(client.query).toHaveBeenLastCalledWith("COMMIT");
});
test("moving to a connection on a different Twilio account is refused", async () => {
  const client = fakeClient(
    moveHandlers({ targetAccount: "AC" + "9".repeat(32) }),
  );
  await expect(
    moveNumber(workspaceId, numberId, targetConnection),
  ).rejects.toThrow("To move a number to another Twilio account");
  expect(ran(client, "UPDATE connection_numbers")).toBe(false);
  expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
});
test("moving needs a real number, a real target and a different connection", async () => {
  await expect(moveNumber(workspaceId, numberId, "nope")).rejects.toThrow(
    "Invalid workspace or number.",
  );
  fakeClient([]);
  await expect(
    moveNumber(workspaceId, numberId, targetConnection),
  ).rejects.toThrow("Number does not belong to this workspace.");
  fakeClient(moveHandlers().slice(0, 1));
  await expect(
    moveNumber(workspaceId, numberId, targetConnection),
  ).rejects.toThrow("Connection does not exist");
  fakeClient(moveHandlers());
  await expect(
    moveNumber(workspaceId, numberId, sourceConnection),
  ).rejects.toThrow("Choose a different connection.");
});
test("move targets list only active workspaces' connections without secrets", async () => {
  pool.query.mockResolvedValueOnce({
    rows: [
      {
        id: targetConnection,
        name: "Kelevo",
        account_sid: "AC1",
        workspace_id: otherId,
        workspace_name: "Kelevo",
      },
    ],
  });
  const rows = await listAllConnections();
  expect(pool.query.mock.calls[0][0]).toContain("w.archived_at IS NULL");
  expect(pool.query.mock.calls[0][0]).not.toContain("encrypted_credentials");
  expect(rows).toHaveLength(1);
});
