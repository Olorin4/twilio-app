// Use a throwaway database with a name ending in _test.
// seedJack uses src/db; point it at the scratch database, never at DB_URL.
jest.mock("../src/db", () => {
  const { Pool } = require("pg");
  return new Pool({ connectionString: process.env.TEST_DB_URL });
});
jest.mock("../src/twilioConnectionValidation", () => ({}));
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const url = process.env.TEST_DB_URL;
const enabled =
  process.env.AGENT_PROFILES_PG_TEST === "1" &&
  url &&
  new URL(url).pathname.endsWith("_test");
const suite = enabled ? describe : describe.skip;

suite("Agent profiles schema against PostgreSQL", () => {
  const workspace = "00000000-0000-4000-8000-000000000001";
  const otherWorkspace = "00000000-0000-4000-8000-000000000002";
  const connection = "00000000-0000-4000-8000-000000000003";
  const numberId = "00000000-0000-4000-8000-000000000004";
  const profileId = "00000000-0000-4000-8000-000000000005";
  const sql = (name) =>
    fs.readFileSync(path.join(__dirname, "../migrations", name), "utf8");
  let pool;

  const insertProfile = (id, workspaceId, overrides = {}) => {
    const p = {
      is_default: false,
      greeting: "Hello",
      ...overrides,
    };
    return pool.query(
      `INSERT INTO agent_profiles
         (id, workspace_id, kind, name, persona_name, company_name,
          greeting, daily_limit, is_default)
       VALUES ($1, $2, 'receptionist', 'n', 'p', 'c', $3, 10, $4)`,
      [id, workspaceId, p.greeting, p.is_default],
    );
  };
  const code = async (promise) => {
    try {
      await promise;
    } catch (error) {
      return error.code;
    }
    return null;
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await pool.query(`
      DROP TABLE IF EXISTS agent_profile_revisions, receptionist_calls,
        connection_numbers, agent_profiles, provider_connections,
        workspaces CASCADE;
      CREATE TABLE workspaces (id uuid PRIMARY KEY, name text);
      CREATE TABLE provider_connections (
        id uuid PRIMARY KEY, workspace_id uuid);
      CREATE TABLE connection_numbers (
        id uuid PRIMARY KEY, connection_id uuid, phone_number text);
    `);
    await pool.query(sql("007_receptionist_calls.sql"));
    await pool.query(sql("013_agent_profiles.sql"));
    await pool.query(sql("013_agent_profiles.sql"));
    await pool.query(
      "INSERT INTO workspaces (id, name) VALUES ($1, 'a'), ($2, 'b')",
      [workspace, otherWorkspace],
    );
    await pool.query(
      "INSERT INTO provider_connections (id, workspace_id) VALUES ($1, $2)",
      [connection, workspace],
    );
    await pool.query(
      `INSERT INTO connection_numbers (id, connection_id, phone_number)
       VALUES ($1, $2, '+12025550100')`,
      [numberId, connection],
    );
  }, 30000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (enabled) await require("../src/db").end();
  });

  test("connection numbers default to the softphone with hours observed", async () => {
    const { rows } = await pool.query(
      "SELECT handler, observe_hours, label FROM connection_numbers WHERE id = $1",
      [numberId],
    );
    expect(rows[0]).toEqual({
      handler: "softphone",
      observe_hours: true,
      label: null,
    });
  });

  test("ai_agent without a profile is rejected", async () => {
    expect(
      await code(
        pool.query(
          "UPDATE connection_numbers SET handler = 'ai_agent' WHERE id = $1",
          [numberId],
        ),
      ),
    ).toBe("23514");
  });

  test("one default profile per workspace", async () => {
    await insertProfile(profileId, workspace, { is_default: true });
    expect(
      await code(
        insertProfile("00000000-0000-4000-8000-000000000006", workspace, {
          is_default: true,
        }),
      ),
    ).toBe("23505");
    await insertProfile(
      "00000000-0000-4000-8000-000000000007",
      otherWorkspace,
      {
        is_default: true,
      },
    );
  });

  test("new outcomes are accepted and unknown ones are not", async () => {
    const insert = (sid, outcome) =>
      pool.query(
        `INSERT INTO receptionist_calls
           (call_sid, workspace_id, from_number, outcome)
         VALUES ($1, $2, '+12025550111', $3)`,
        [sid, workspace, outcome],
      );
    for (const outcome of [
      "message",
      "urgent",
      "support_request",
      "not_support",
    ]) {
      await insert("CA" + outcome, outcome);
    }
    expect(await code(insert("CAbogus", "bogus"))).toBe("23514");
  });

  test("seedJack creates one default profile and is rerunnable", async () => {
    const { seedJack } = require("../src/agentProfiles");
    await pool.query("DELETE FROM agent_profiles WHERE workspace_id = $1", [
      workspace,
    ]);
    expect(await seedJack()).toEqual({ created: true });
    expect(await seedJack()).toEqual({ created: false });
    const profiles = await pool.query(
      "SELECT id, kind, is_default FROM agent_profiles WHERE workspace_id = $1",
      [workspace],
    );
    expect(profiles.rows).toHaveLength(1);
    expect(profiles.rows[0]).toMatchObject({
      kind: "receptionist",
      is_default: true,
    });
    const revisions = await pool.query(
      "SELECT saved_by FROM agent_profile_revisions WHERE profile_id = $1",
      [profiles.rows[0].id],
    );
    expect(revisions.rows).toEqual([{ saved_by: "import" }]);
  });

  test("restoring an earlier revision keeps history; other workspaces change nothing", async () => {
    const {
      updateProfile,
      listRevisions,
      restoreRevision,
      getProfile,
    } = require("../src/agentProfiles");
    const [{ id }] = (
      await pool.query(
        "SELECT id FROM agent_profiles WHERE workspace_id = $1 AND is_default",
        [workspace],
      )
    ).rows;
    const original = (await getProfile(id)).greeting;
    await updateProfile(workspace, id, { greeting: "Edited" }, "operator");
    const before = await listRevisions(workspace, id);
    expect(before).toHaveLength(2);
    const first = before[before.length - 1];
    const restored = await restoreRevision(workspace, id, first.id, "operator");
    expect(restored.greeting).toBe(original);
    expect((await getProfile(id)).greeting).toBe(original);
    expect(await listRevisions(workspace, id)).toHaveLength(3);

    await expect(
      updateProfile(otherWorkspace, id, { greeting: "Hijack" }, "operator"),
    ).rejects.toThrow("Agent does not exist.");
    await expect(
      restoreRevision(otherWorkspace, id, first.id, "operator"),
    ).rejects.toThrow("Revision does not exist.");
    expect((await getProfile(id)).greeting).toBe(original);
    expect(await listRevisions(workspace, id)).toHaveLength(3);
  });

  test("profile fields are capped", async () => {
    expect(
      await code(
        insertProfile("00000000-0000-4000-8000-000000000008", workspace, {
          greeting: "x".repeat(501),
        }),
      ),
    ).toBe("23514");
  });
});
