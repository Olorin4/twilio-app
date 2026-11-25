jest.mock("../src/db", () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock("../src/twilioConnectionValidation", () => ({}));
const pool = require("../src/db");
const {
  validateFields,
  createProfile,
  updateProfile,
  setDefault,
  restoreRevision,
  seedJack,
} = require("../src/agentProfiles");
const { JACK } = require("../src/receptionist/seed/jack");
const { IRON_WING_WORKSPACE_ID } = require("../src/workspaceContext");

const ws = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const id = "00000000-0000-4000-8000-000000000005";
const base = {
  kind: "receptionist",
  name: "Front desk",
  personaName: "Jack",
  companyName: "Acme",
  greeting: "Hello",
};
const row = (over = {}) => ({
  id,
  workspace_id: ws,
  kind: "receptionist",
  name: "Front desk",
  persona_name: "Jack",
  company_name: "Acme",
  greeting: "Hello",
  instructions: "",
  knowledge: "",
  voice: null,
  alert_email: null,
  daily_limit: 3,
  enabled: true,
  is_default: false,
  ...over,
});
function client(handler) {
  const query = jest.fn(async (sql, params) => {
    const out = handler && handler(sql, params);
    return out || { rows: [] };
  });
  pool.connect.mockResolvedValueOnce({ query, release: jest.fn() });
  return query;
}
const sqls = (query) => query.mock.calls.map(([sql]) => String(sql));
const originalLimit = process.env.RECEPTIONIST_DAILY_LIMIT;
beforeEach(() => {
  jest.resetAllMocks();
  delete process.env.RECEPTIONIST_DAILY_LIMIT;
});
afterAll(() => {
  if (originalLimit !== undefined)
    process.env.RECEPTIONIST_DAILY_LIMIT = originalLimit;
});

test("validation enforces the caps", () => {
  const bad = [
    { greeting: "x".repeat(501) },
    { instructions: "x".repeat(20001) },
    { knowledge: "x".repeat(60001) },
    { kind: "pirate" },
    { daily_limit: 0 },
    { alert_email: "no-at-sign" },
  ];
  for (const fields of bad)
    expect(() => validateFields(fields)).toThrow(/^Enter valid agent settings/);
  expect(validateFields({ daily_limit: 5, alert_email: "a@b.co" })).toEqual({
    dailyLimit: 5,
    alertEmail: "a@b.co",
  });
});

test("create defaults the daily limit by kind", async () => {
  for (const [kind, limit] of [
    ["receptionist", 3],
    ["dispatcher", 20],
  ]) {
    const query = client((sql) =>
      sql.includes("INSERT INTO agent_profiles")
        ? { rows: [row({ kind, daily_limit: limit })] }
        : null,
    );
    await createProfile(ws, { ...base, kind }, "operator");
    const insert = query.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO agent_profiles"),
    );
    expect(insert[1][11]).toBe(limit);
  }
});

test("every save writes a revision in the same transaction", async () => {
  const query = client((sql) =>
    sql.includes("UPDATE agent_profiles") ? { rows: [row()] } : null,
  );
  await updateProfile(ws, id, { greeting: "Hi", kind: "support" }, "operator");
  const s = sqls(query);
  expect(s[0]).toBe("BEGIN");
  expect(s[1]).toContain("UPDATE agent_profiles");
  expect(s[1]).not.toContain("kind =");
  expect(s[2]).toContain("INSERT INTO agent_profile_revisions");
  expect(s[3]).toBe("COMMIT");
  const fields = JSON.parse(query.mock.calls[2][1][1]);
  expect(Object.keys(fields).sort()).toEqual(
    [
      "name",
      "personaName",
      "companyName",
      "greeting",
      "instructions",
      "knowledge",
      "voice",
      "alertEmail",
      "dailyLimit",
      "enabled",
      "aiDisclosure",
    ].sort(),
  );
  expect(query.mock.calls[2][1][2]).toBe("operator");
});

test("restore saves a new revision and keeps the old ones", async () => {
  const query = client((sql) => {
    if (sql.includes("FROM agent_profile_revisions"))
      return { rows: [{ fields: { greeting: "Old", voice: null } }] };
    if (sql.includes("UPDATE agent_profiles"))
      return { rows: [row({ greeting: "Old" })] };
    return null;
  });
  const profile = await restoreRevision(ws, id, 7, "operator");
  expect(profile.greeting).toBe("Old");
  const lookup = query.mock.calls.find(([sql]) =>
    sql.includes("FROM agent_profile_revisions"),
  );
  expect(lookup[0]).toContain("JOIN agent_profiles");
  expect(lookup[0]).toContain("p.workspace_id = $1");
  expect(lookup[0]).toContain("p.id = $2");
  expect(lookup[0]).toContain("r.id = $3");
  expect(lookup[1]).toEqual([ws, id, 7]);
  const update = query.mock.calls.find(([sql]) =>
    sql.includes("UPDATE agent_profiles"),
  );
  expect(update[0]).toContain("workspace_id = $1");
  expect(update[1].slice(0, 2)).toEqual([ws, id]);
  expect(update[1]).toContain("Old");
  const s = sqls(query);
  expect(s.some((q) => q.includes("INSERT INTO agent_profile_revisions"))).toBe(
    true,
  );
  expect(s.some((q) => /DELETE/i.test(q))).toBe(false);
  expect(s[s.length - 1]).toBe("COMMIT");
});

test("profiles from another workspace are not found", async () => {
  const query = client();
  await expect(
    updateProfile(other, id, { greeting: "Hi" }, "operator"),
  ).rejects.toThrow("Agent does not exist.");
  expect(sqls(query)).toContain("ROLLBACK");
  expect(sqls(query).some((q) => q.includes("INSERT"))).toBe(false);
  const update = query.mock.calls.find(([sql]) =>
    sql.includes("UPDATE agent_profiles"),
  );
  expect(update[0]).toContain("workspace_id = $1");
  expect(update[0]).toContain("id = $2");
  expect(update[1][0]).toBe(other);
  expect(update[1][1]).toBe(id);
});

test("setDefault clears the old default first", async () => {
  const query = client((sql) =>
    sql.includes("SET is_default = true")
      ? { rows: [row({ is_default: true })] }
      : null,
  );
  const profile = await setDefault(ws, id);
  expect(profile.isDefault).toBe(true);
  const s = sqls(query);
  const clear = s.findIndex((q) => q.includes("SET is_default = false"));
  const set = s.findIndex((q) => q.includes("SET is_default = true"));
  expect(s[0]).toBe("BEGIN");
  expect(clear).toBeGreaterThan(0);
  expect(set).toBeGreaterThan(clear);
  expect(query.mock.calls[clear][0]).toMatch(
    /WHERE workspace_id = \$1 AND is_default/,
  );
  expect(s[s.length - 1]).toBe("COMMIT");
});

describe("seedJack", () => {
  test("is insert-only", async () => {
    const query = client((sql) =>
      sql.includes("SELECT 1 FROM agent_profiles") ? { rows: [{}] } : null,
    );
    expect(await seedJack()).toEqual({ created: false });
    expect(sqls(query).some((q) => q.includes("INSERT"))).toBe(false);
  });

  test("inserts Jack as the default receptionist with an import revision", async () => {
    const query = client((sql) =>
      sql.includes("INSERT INTO agent_profiles")
        ? { rows: [row({ is_default: true })] }
        : null,
    );
    expect(await seedJack()).toEqual({ created: true });
    const insert = query.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO agent_profiles"),
    );
    expect(insert[1][1]).toBe(IRON_WING_WORKSPACE_ID);
    expect(insert[1][2]).toBe("receptionist");
    expect(insert[1][6]).toBe(JACK.greeting);
    expect(insert[1][13]).toBe(true);
    const revision = query.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO agent_profile_revisions"),
    );
    expect(revision[1][2]).toBe("import");
  });
});

describe("AI disclosure", () => {
  test("defaults to when asked and accepts in greeting", () => {
    expect(validateFields({ aiDisclosure: "in_greeting" })).toEqual({
      aiDisclosure: "in_greeting",
    });
    expect(validateFields({ ai_disclosure: "when_asked" })).toEqual({
      aiDisclosure: "when_asked",
    });
  });
  test("rejects any other value, including never", () => {
    for (const value of ["never", "", "IN_GREETING", true])
      expect(() => validateFields({ aiDisclosure: value })).toThrow(
        "Enter valid agent settings: AI disclosure must be when_asked or in_greeting.",
      );
  });
  test("a greeting that discloses must say AI", async () => {
    await expect(
      createProfile(
        ws,
        { ...base, aiDisclosure: "in_greeting", greeting: "Hi, this is Sam." },
        "owner",
      ),
    ).rejects.toThrow(
      "Enter valid agent settings: with disclosure in the greeting, the greeting must say the caller is talking to an AI assistant.",
    );
    expect(pool.connect).not.toHaveBeenCalled();
  });
  test("switching to in greeting checks the stored greeting and rolls back", async () => {
    const query = client((sql) =>
      sql.includes("UPDATE agent_profiles SET")
        ? { rows: [row({ ai_disclosure: "in_greeting", greeting: "Hello" })] }
        : null,
    );
    await expect(
      updateProfile(ws, id, { aiDisclosure: "in_greeting" }, "owner"),
    ).rejects.toThrow("the greeting must say the caller is talking to an AI");
    expect(sqls(query)).toContain("ROLLBACK");
    expect(sqls(query).some((s) => s.includes("agent_profile_revisions"))).toBe(
      false,
    );
  });
  test("a disclosing greeting passes", async () => {
    client((sql) =>
      sql.includes("INSERT INTO agent_profiles")
        ? {
            rows: [
              row({
                ai_disclosure: "in_greeting",
                greeting: "Hi, I'm Sam, Iron Wing's AI assistant.",
              }),
            ],
          }
        : null,
    );
    const created = await createProfile(
      ws,
      {
        ...base,
        aiDisclosure: "in_greeting",
        greeting: "Hi, I'm Sam, Iron Wing's AI assistant.",
      },
      "owner",
    );
    expect(created.aiDisclosure).toBe("in_greeting");
  });
});
