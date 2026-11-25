jest.mock("../src/legacyLine", () => ({
  legacyMoved: jest.fn(async () => false),
  movedLegacyNumbers: jest.fn(async () => []),
}));
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
  updateNumberSettings,
  listAllConnections,
  setNumberAssignees,
  addConnectionNumbers,
  selectLegacy,
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
describe("adding the legacy number to a connection", () => {
  const connectionId = "00000000-0000-4000-8000-0000000000c1";
  const saved = {};
  beforeEach(() => {
    for (const key of ["TWILIO_CALLER_ID", "TWILIO_ACCOUNT_SID"])
      saved[key] = process.env[key];
    process.env.TWILIO_CALLER_ID = "+15550000001";
    process.env.TWILIO_ACCOUNT_SID = credentials.accountSid;
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    // Unused queued answers must not leak into later tests.
    pool.query.mockReset();
    pool.connect.mockReset();
  });
  // The connection row readConnectionCredentials loads.
  const connectionRow = (accountSid) => ({
    rows: [
      {
        id: connectionId,
        account_sid: accountSid,
        encrypted_credentials: encryptCredentials(connectionId, {
          authToken: "a",
          apiKeySid: credentials.apiKeySid,
          apiKeySecret: "s",
          twimlAppSid: credentials.twimlAppSid,
        }),
      },
    ],
  });
  const add = (workspace) =>
    addConnectionNumbers(workspace, connectionId, ["PN1"], {
      validate: async () => ({ numbers: owned }),
    });

  test("Iron Wing's own connection on the legacy account may take the legacy number", async () => {
    pool.query.mockResolvedValueOnce(connectionRow(credentials.accountSid));
    const query = jest.fn().mockResolvedValue({ rows: [] });
    query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: connectionId }] }); // lock
    pool.connect.mockResolvedValueOnce({ query, release: jest.fn() });
    await expect(add(workspaceId)).resolves.toEqual({ added: 1 });
    expect(query).toHaveBeenLastCalledWith("COMMIT");
  });

  test("another workspace's connection still cannot take it", async () => {
    pool.query.mockResolvedValueOnce(connectionRow(credentials.accountSid));
    await expect(add("00000000-0000-4000-8000-000000000002")).rejects.toThrow(
      "The current Iron Wing number is already assigned to the environment connection.",
    );
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test("an Iron Wing connection on another Twilio account still cannot take it", async () => {
    pool.query.mockResolvedValueOnce(connectionRow("AC" + "9".repeat(32)));
    await expect(add(workspaceId)).rejects.toThrow(
      "The current Iron Wing number is already assigned to the environment connection.",
    );
    expect(pool.connect).not.toHaveBeenCalled();
  });
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
const listOwner = { id: "o1", role: "owner", workspaceIds: [] };
const listMember = {
  id: "11111111-1111-4111-8111-111111111111",
  role: "member",
  workspaceIds: [otherId],
};
test("archived workspaces are left out of lists and voice targets", async () => {
  pool.query.mockResolvedValue({ rows: [] });
  await listWorkspaces(listOwner);
  await listVoiceTargets(listOwner);
  expect(pool.query.mock.calls[0][0]).toContain("w.archived_at IS NULL");
  expect(pool.query.mock.calls[1][0]).toContain("w.archived_at IS NULL");
});

test("workspace lists are filtered for members", async () => {
  process.env.TWILIO_CALLER_ID = "+15550009999";
  pool.query.mockResolvedValue({ rows: [{ name: "Iron Wing" }] });
  await listWorkspaces(listMember);
  let [sql, params] = pool.query.mock.calls[0];
  expect(sql).toMatch(
    /JOIN workspace_members \w+ ON \w+\.workspace_id = w\.id AND \w+\.user_id = \$3/,
  );
  expect(params[2]).toBe(listMember.id);

  pool.query.mockClear();
  pool.query.mockResolvedValue({ rows: [] });
  const targets = await listVoiceTargets(listMember);
  [sql, params] = pool.query.mock.calls[0];
  expect(sql).toMatch(
    /JOIN workspace_members \w+ ON \w+\.workspace_id = w\.id AND \w+\.user_id = \$1/,
  );
  expect(params).toEqual([listMember.id]);
  // The legacy number is owners only.
  expect(targets.some((t) => t.connection_id === "legacy")).toBe(false);
  if (originalCaller === undefined) delete process.env.TWILIO_CALLER_ID;
  else process.env.TWILIO_CALLER_ID = originalCaller;
});

test("members never see a workspace's active phone number", async () => {
  pool.query.mockImplementation(async () => ({
    rows: [{ id: otherId, name: "Acme", active_phone: "+15550001111" }],
  }));
  expect((await listWorkspaces(listMember))[0].active_phone).toBeNull();
  expect((await listWorkspaces(listOwner))[0].active_phone).toBe(
    "+15550001111",
  );
});

test("a member's voice targets are their own assigned voice lines", async () => {
  pool.query.mockResolvedValue({ rows: [] });
  await listVoiceTargets(listMember);
  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toMatch(
    /JOIN number_assignees na ON na\.number_id = n\.id AND na\.user_id = \$1/,
  );
  expect(sql).toMatch(/ORDER BY c\.id, na\.created_at, n\.id/);
  expect(params).toEqual([listMember.id]);
  pool.query.mockClear();
  await listVoiceTargets(listOwner);
  expect(pool.query.mock.calls[0][0]).not.toContain("number_assignees");
});

test("owners list every workspace without a membership join", async () => {
  process.env.TWILIO_CALLER_ID = "+15550009999";
  pool.query.mockResolvedValue({ rows: [{ name: "Iron Wing" }] });
  for (const user of [
    listOwner,
    { id: null, role: "owner", bootstrap: true, workspaceIds: [] },
  ]) {
    pool.query.mockClear();
    await listWorkspaces(user);
    expect(pool.query.mock.calls[0][0]).not.toContain("workspace_members");
    pool.query.mockClear();
    const targets = await listVoiceTargets(user);
    expect(pool.query.mock.calls[0][0]).not.toContain("workspace_members");
    expect(targets.some((t) => t.connection_id === "legacy")).toBe(true);
  }
  if (originalCaller === undefined) delete process.env.TWILIO_CALLER_ID;
  else process.env.TWILIO_CALLER_ID = originalCaller;
});

test("workspace lists fail closed without a user", async () => {
  pool.query.mockResolvedValue({ rows: [] });
  await expect(listWorkspaces()).rejects.toThrow();
  await expect(listVoiceTargets()).rejects.toThrow();
  await expect(listWorkspaces({ role: "member" })).rejects.toThrow();
  expect(pool.query).not.toHaveBeenCalled();
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

const profileId = "00000000-0000-4000-8000-0000000000c1";
const settingsHandlers = (profileRows = [{ id: profileId }]) => [
  [
    "FROM connection_numbers n",
    {
      rows: [
        {
          id: numberId,
          handler: "softphone",
          label: "Old",
          observe_hours: true,
        },
      ],
    },
  ],
  ["FROM agent_profiles", { rows: profileRows }],
  [
    "UPDATE connection_numbers",
    {
      rows: [
        {
          id: numberId,
          handler: "ai_agent",
          agent_profile_id: profileId,
          label: null,
          observe_hours: true,
        },
      ],
    },
  ],
];
const updateParams = (client) =>
  client.query.mock.calls.find(([sql]) =>
    sql.includes("UPDATE connection_numbers"),
  )[1];
test("ai_agent needs an agent from the number's workspace", async () => {
  const client = fakeClient(settingsHandlers([]));
  await expect(
    updateNumberSettings(workspaceId, numberId, {
      handler: "ai_agent",
      agentProfileId: profileId,
    }),
  ).rejects.toThrow("Choose an agent from this workspace.");
  expect(ran(client, "UPDATE connection_numbers")).toBe(false);
  expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
  fakeClient(settingsHandlers());
  await expect(
    updateNumberSettings(workspaceId, numberId, { handler: "ai_agent" }),
  ).rejects.toThrow("Choose an agent from this workspace.");
});
test("ai_agent with a valid agent stores it and locks the number row", async () => {
  const client = fakeClient(settingsHandlers());
  const result = await updateNumberSettings(workspaceId, numberId, {
    handler: "ai_agent",
    agentProfileId: profileId,
    label: "Main",
    observeHours: false,
  });
  expect(result.handler).toBe("ai_agent");
  expect(
    client.query.mock.calls.find(([sql]) => sql.includes("FOR UPDATE"))[0],
  ).toContain("FROM connection_numbers n");
  expect(updateParams(client)).toEqual([
    numberId,
    "ai_agent",
    profileId,
    "Main",
    false,
    false,
  ]);
  expect(client.query).toHaveBeenLastCalledWith("COMMIT");
});
test("softphone clears the agent", async () => {
  const client = fakeClient(settingsHandlers());
  await updateNumberSettings(workspaceId, numberId, {
    handler: "softphone",
    agentProfileId: profileId,
    label: "Main",
    observeHours: true,
  });
  expect(updateParams(client)[2]).toBeNull();
  expect(ran(client, "FROM agent_profiles")).toBe(false);
});
test("labels are trimmed and capped", async () => {
  await expect(
    updateNumberSettings(workspaceId, numberId, {
      handler: "softphone",
      label: "x".repeat(61),
    }),
  ).rejects.toThrow("Enter a line label of up to 60 characters.");
  let client = fakeClient(settingsHandlers());
  await updateNumberSettings(workspaceId, numberId, {
    handler: "softphone",
    label: "  Manager ",
  });
  expect(updateParams(client)[3]).toBe("Manager");
  client = fakeClient(settingsHandlers());
  await updateNumberSettings(workspaceId, numberId, {
    handler: "softphone",
    label: "",
  });
  expect(updateParams(client)[3]).toBeNull();
});
test("number settings reject bad ids, handlers and foreign numbers", async () => {
  await expect(
    updateNumberSettings("nope", numberId, { handler: "softphone" }),
  ).rejects.toThrow("Invalid workspace or number.");
  await expect(
    updateNumberSettings(workspaceId, numberId, { handler: "robot" }),
  ).rejects.toThrow("Enter valid number settings.");
  fakeClient([]);
  await expect(
    updateNumberSettings(workspaceId, numberId, { handler: "softphone" }),
  ).rejects.toThrow("Number does not belong to this workspace.");
});
test("moving a number resets its handler and keeps its label", async () => {
  const client = fakeClient(moveHandlers());
  await moveNumber(workspaceId, numberId, targetConnection);
  const [sql] = client.query.mock.calls.find(([text]) =>
    text.includes("UPDATE connection_numbers"),
  );
  expect(sql).toContain("handler = 'softphone'");
  expect(sql).toContain("agent_profile_id = NULL");
  expect(sql).not.toContain("label");
});
test("listConnections numbers carry handler, agent, label and hours", async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [{ id: sourceConnection }] })
    .mockResolvedValueOnce({ rows: [] });
  await listConnections(workspaceId);
  const sql = pool.query.mock.calls[1][0];
  for (const column of [
    "handler",
    "agent_profile_id",
    "label",
    "observe_hours",
  ])
    expect(sql).toContain(`n.${column}`);
});

const alice = "00000000-0000-4000-8000-0000000000d1";
const bob = "00000000-0000-4000-8000-0000000000d2";
const assigneeHandlers = (allowedRows) => [
  ["FROM connection_numbers n", { rows: [{ id: numberId }] }],
  ["FROM app_users u", { rows: allowedRows }],
];
test("assignees must be able to open the workspace", async () => {
  // Only Alice is enabled and an owner or member of this workspace.
  let client = fakeClient(assigneeHandlers([{ id: alice }]));
  await expect(
    setNumberAssignees(workspaceId, numberId, [alice, bob]),
  ).rejects.toThrow("Choose people who can open this workspace.");
  expect(ran(client, "INSERT INTO number_assignees")).toBe(false);
  expect(ran(client, "DELETE FROM number_assignees")).toBe(false);
  expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
  const check = client.query.mock.calls.find(([sql]) =>
    sql.includes("FROM app_users u"),
  );
  expect(check[0]).toContain("u.enabled");
  expect(check[0]).toContain("u.role = 'owner'");
  expect(check[0]).toContain("workspace_members");
  expect(check[1]).toEqual([[alice, bob], workspaceId]);

  client = fakeClient(assigneeHandlers([{ id: alice }, { id: bob }]));
  expect(await setNumberAssignees(workspaceId, numberId, [bob, alice])).toEqual(
    { numberId, userIds: [bob, alice] },
  );
  expect(
    client.query.mock.calls.find(([sql]) => sql.includes("FOR UPDATE"))[0],
  ).toContain("FROM connection_numbers n");
  const insert = client.query.mock.calls.find(([sql]) =>
    sql.includes("INSERT INTO number_assignees"),
  );
  expect(insert[1]).toEqual([numberId, [bob, alice]]);
  expect(client.query).toHaveBeenLastCalledWith("COMMIT");

  // An empty list clears the line, so it rings the owners.
  client = fakeClient(assigneeHandlers([]));
  expect(await setNumberAssignees(workspaceId, numberId, [])).toEqual({
    numberId,
    userIds: [],
  });
  expect(ran(client, "DELETE FROM number_assignees")).toBe(true);

  fakeClient([]);
  await expect(
    setNumberAssignees(workspaceId, numberId, [alice]),
  ).rejects.toThrow("Number does not belong to this workspace.");
  for (const bad of [undefined, "x", [alice, alice], ["nope"]])
    await expect(
      setNumberAssignees(workspaceId, numberId, bad),
    ).rejects.toThrow("Choose people who can open this workspace.");
  await expect(setNumberAssignees("nope", numberId, [])).rejects.toThrow(
    "Invalid workspace or number.",
  );
});

test("personal and ai_agent cannot combine", async () => {
  await expect(
    updateNumberSettings(workspaceId, numberId, {
      handler: "ai_agent",
      agentProfileId: profileId,
      personal: true,
    }),
  ).rejects.toThrow("A personal line can't be answered by an AI agent.");
  await expect(
    updateNumberSettings(workspaceId, numberId, {
      handler: "softphone",
      personal: "yes",
    }),
  ).rejects.toThrow("Enter valid number settings.");

  // A line that is already personal can't switch to an agent either.
  const personalRow = settingsHandlers();
  personalRow[0][1].rows[0].personal = true;
  let client = fakeClient(personalRow);
  await expect(
    updateNumberSettings(workspaceId, numberId, {
      handler: "ai_agent",
      agentProfileId: profileId,
    }),
  ).rejects.toThrow("A personal line can't be answered by an AI agent.");
  expect(ran(client, "UPDATE connection_numbers")).toBe(false);

  // Unless the same request makes it shared again.
  const sharedAgain = settingsHandlers();
  sharedAgain[0][1].rows[0].personal = true;
  client = fakeClient(sharedAgain);
  await updateNumberSettings(workspaceId, numberId, {
    handler: "ai_agent",
    agentProfileId: profileId,
    personal: false,
  });
  expect(updateParams(client)[5]).toBe(false);

  client = fakeClient(settingsHandlers());
  await updateNumberSettings(workspaceId, numberId, {
    handler: "softphone",
    personal: true,
  });
  expect(updateParams(client)[5]).toBe(true);
  // Leaving personal out keeps the stored value.
  const kept = settingsHandlers();
  kept[0][1].rows[0].personal = true;
  client = fakeClient(kept);
  await updateNumberSettings(workspaceId, numberId, { handler: "softphone" });
  expect(updateParams(client)[5]).toBe(true);
});

test("moving a number clears its assignees", async () => {
  const client = fakeClient(moveHandlers());
  await moveNumber(workspaceId, numberId, targetConnection);
  const cleared = client.query.mock.calls.find(([sql]) =>
    sql.includes("DELETE FROM number_assignees"),
  );
  expect(cleared[1]).toEqual([numberId]);
  const [sql] = client.query.mock.calls.find(([text]) =>
    text.includes("UPDATE connection_numbers"),
  );
  expect(sql).toContain("personal = false");
  expect(client.query).toHaveBeenLastCalledWith("COMMIT");
});

test("listConnections numbers carry their assignees and personal", async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [{ id: sourceConnection }] })
    .mockResolvedValueOnce({
      rows: [
        { id: numberId, connection_id: sourceConnection, personal: true },
        {
          id: "00000000-0000-4000-8000-0000000000a2",
          connection_id: sourceConnection,
          personal: false,
        },
      ],
    })
    .mockResolvedValueOnce({
      rows: [
        { number_id: numberId, id: bob, display_name: "Bob" },
        { number_id: numberId, id: alice, display_name: "Alice" },
      ],
    });
  const [connection] = await listConnections(workspaceId);
  expect(pool.query.mock.calls[1][0]).toContain("n.personal");
  const assignees = pool.query.mock.calls[2][0];
  expect(assignees).toContain("u.enabled");
  expect(assignees).toContain("workspace_members");
  expect(connection.numbers[0]).toMatchObject({
    personal: true,
    assignees: [
      { id: bob, displayName: "Bob" },
      { id: alice, displayName: "Alice" },
    ],
  });
  expect(connection.numbers[1]).toMatchObject({
    personal: false,
    assignees: [],
  });
});

describe("once the main number is moved into the connection", () => {
  const { legacyMoved } = require("../src/legacyLine");
  afterEach(() => {
    legacyMoved.mockResolvedValue(false);
    pool.query.mockReset();
  });
  test("choosing the legacy number is refused and the active line is kept", async () => {
    legacyMoved.mockResolvedValue(true);
    await expect(selectLegacy(workspaceId)).rejects.toThrow(
      "The main number now belongs to the Iron Wing connection.",
    );
    expect(pool.query).not.toHaveBeenCalled();
  });
  test("before the move, choosing the legacy number clears the active line", async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await expect(selectLegacy(workspaceId)).resolves.toEqual({
      workspace_id: workspaceId,
      legacy: true,
    });
    expect(pool.query.mock.calls[0][0]).toContain(
      "DELETE FROM workspace_active_numbers",
    );
  });
  test("the workspace list has no legacy active-phone fallback", async () => {
    legacyMoved.mockResolvedValue(true);
    process.env.TWILIO_CALLER_ID = "+15550009999";
    pool.query.mockResolvedValue({ rows: [] });
    await listWorkspaces(listOwner);
    expect(pool.query.mock.calls[0][1][1]).toBeNull();
  });
  test("before the move, the legacy number is the active-phone fallback", async () => {
    process.env.TWILIO_CALLER_ID = "+15550009999";
    pool.query.mockResolvedValue({ rows: [] });
    await listWorkspaces(listOwner);
    expect(pool.query.mock.calls[0][1][1]).toBe("+15550009999");
  });
});
