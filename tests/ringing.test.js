/* Who a call rings. The ring list is one SQL query, so its rules (enabled
users, workspace access, order, the cap and the owner fallback) run against a throwaway PostgreSQL database when RINGING_PG_TEST=1. The
failure paths run everywhere. */
jest.mock("../src/db", () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock("../src/twilioConnectionValidation", () => ({}));
jest.mock("../src/token", () => ({ getIdentity: () => "iron_wing_desk" }));
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const pool = require("../src/db");
const {
  ringIdentities,
  RING_DEADLINE_MS,
  mayUseLine,
  lineRole,
  usableLines,
} = require("../src/ringing");

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE = "00000000-0000-4000-8000-000000000002";
const CONNECTION = "00000000-0000-4000-8000-000000000003";
const NUMBER = "00000000-0000-4000-8000-000000000004";
const compact = (id) => id.replace(/-/g, "");
const line = {
  legacy: false,
  id: CONNECTION,
  numberId: NUMBER,
  workspaceId: WORKSPACE,
  phoneNumber: "+12025550100",
};
const legacyLine = { legacy: true, workspaceId: WORKSPACE };
const onLine = (userId) => `u${compact(userId)}_c${compact(CONNECTION)}`;
const onLegacy = (userId) => `u${compact(userId)}_legacy`;

describe("when the ring list can't be read", () => {
  let errorLog;
  beforeEach(() => {
    jest.clearAllMocks();
    errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errorLog.mockRestore());

  test("a database error returns the bootstrap identity", async () => {
    pool.query.mockRejectedValue(new Error("connection refused"));
    expect(await ringIdentities(line)).toEqual([
      `connection_${compact(CONNECTION)}`,
    ]);
    expect(await ringIdentities(legacyLine)).toEqual(["iron_wing_desk"]);
    expect(await ringIdentities(undefined)).toEqual(["iron_wing_desk"]);
    expect(errorLog).toHaveBeenCalled();
  });

  test("a slow database returns the bootstrap identity at the deadline", async () => {
    jest.useFakeTimers();
    try {
      pool.query.mockReturnValue(new Promise(() => {}));
      const pending = ringIdentities(line);
      await jest.advanceTimersByTimeAsync(RING_DEADLINE_MS);
      expect(await pending).toEqual([`connection_${compact(CONNECTION)}`]);
      expect(RING_DEADLINE_MS).toBeLessThanOrEqual(1500);
    } finally {
      jest.useRealTimers();
    }
  });

  test("the list is read with one query per call", async () => {
    pool.query.mockResolvedValue({ rows: [{ id: NUMBER }] });
    expect(await ringIdentities(line)).toEqual([onLine(NUMBER)]);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][1]).toEqual([NUMBER, WORKSPACE]);
  });
});

describe("who may use a line, without a database", () => {
  beforeEach(() => jest.clearAllMocks());

  test("the bootstrap user may use any line only while no enabled owner exists", async () => {
    const bootstrap = { id: null, role: "owner", bootstrap: true };
    pool.query.mockResolvedValue({ rows: [{ exists: false }] });
    expect(await mayUseLine(bootstrap, line)).toBe(true);
    expect(await mayUseLine(bootstrap, legacyLine)).toBe(true);
    expect(await lineRole(bootstrap, line)).toBe("owner");
    expect(pool.query.mock.calls[0][0]).toMatch(/role = 'owner' AND enabled/);
  });

  test("after cutover a bootstrap identity's still-valid token places no calls", async () => {
    const bootstrap = { id: null, bootstrap: true };
    pool.query.mockResolvedValue({ rows: [{ exists: true }] });
    expect(await lineRole(bootstrap, line)).toBeNull();
    expect(await lineRole(bootstrap, legacyLine)).toBeNull();
    expect(await mayUseLine(bootstrap, line)).toBe(false);
  });

  test("a bootstrap check that can't read the database throws (fails closed)", async () => {
    pool.query.mockRejectedValue(new Error("connection refused"));
    await expect(lineRole({ id: null, bootstrap: true }, line)).rejects.toThrow(
      "connection refused",
    );
  });

  test("nobody, or a user without a valid id, may use no line", async () => {
    expect(await mayUseLine(null, line)).toBe(false);
    expect(await mayUseLine({ id: "not-a-uuid" }, line)).toBe(false);
    expect(await mayUseLine({ id: NUMBER }, null)).toBe(false);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test("the user is read from the database, not trusted from the caller", async () => {
    pool.query.mockResolvedValue({
      rows: [{ role: "member", enabled: true, assigned: false, member: true }],
    });
    // A caller-supplied role of owner changes nothing.
    expect(await mayUseLine({ id: NUMBER, role: "owner" }, line)).toBe(false);
    expect(pool.query.mock.calls[0][1]).toEqual([NUMBER, NUMBER, WORKSPACE]);
  });
});

const url = process.env.TEST_DB_URL;
const enabled =
  process.env.RINGING_PG_TEST === "1" &&
  url &&
  new URL(url).pathname.endsWith("_test");
const suite = enabled ? describe : describe.skip;

suite("ring list against PostgreSQL", () => {
  // Its own schema, so it can run beside the other PostgreSQL suites.
  const schema = "ringing_pg_test";
  let admin;
  let db;
  let seq = 0;
  const uid = () =>
    `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

  async function user(role, { enabled: on = true, member = false } = {}) {
    const id = uid();
    await db.query(
      `INSERT INTO app_users (id, username, display_name, password_hash, role, enabled, created_at)
       VALUES ($1, $2, $2, 'x', $3, $4, now() + ($5 || ' seconds')::interval)`,
      [id, `user${seq}`, role, on, String(seq)],
    );
    if (member)
      await db.query(
        "INSERT INTO workspace_members (workspace_id, user_id) VALUES ($1, $2)",
        [WORKSPACE, id],
      );
    return id;
  }
  const assign = (userId, secondsAgo) =>
    db.query(
      `INSERT INTO number_assignees (number_id, user_id, created_at)
       VALUES ($1, $2, now() - ($3 || ' seconds')::interval)`,
      [NUMBER, userId, String(secondsAgo)],
    );

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = new Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
    });
    await db.query(`
      CREATE TABLE workspaces (id uuid PRIMARY KEY, name text);
      CREATE TABLE provider_connections (
        id uuid PRIMARY KEY, workspace_id uuid, provider text, name text,
        account_sid text, twiml_app_sid text, created_at timestamptz,
        updated_at timestamptz);
      CREATE TABLE connection_numbers (
        id uuid PRIMARY KEY, connection_id uuid, phone_number text,
        provider_number_sid text, voice_enabled boolean, sms_enabled boolean,
        handler text, agent_profile_id uuid, label text, observe_hours boolean);
      CREATE TABLE workspace_active_numbers (
        workspace_id uuid PRIMARY KEY, connection_number_id uuid);
    `);
    await db.query(
      fs.readFileSync(
        path.join(__dirname, "../migrations/014_users.sql"),
        "utf8",
      ),
    );
    await db.query(
      "INSERT INTO workspaces (id, name) VALUES ($1, 'a'), ($2, 'b')",
      [WORKSPACE, OTHER_WORKSPACE],
    );
    await db.query(
      "INSERT INTO provider_connections (id, workspace_id) VALUES ($1, $2)",
      [CONNECTION, WORKSPACE],
    );
    await db.query(
      "INSERT INTO connection_numbers (id, connection_id, phone_number) VALUES ($1, $2, '+12025550100')",
      [NUMBER, CONNECTION],
    );
    pool.query.mockImplementation((...args) => db.query(...args));
    pool.connect.mockImplementation(() => db.connect());
  }, 30000);
  beforeEach(() =>
    db.query("TRUNCATE number_assignees, workspace_members, app_users"),
  );
  afterAll(async () => {
    if (db) await db.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  test("assignees ring and nobody else", async () => {
    const owner = await user("owner");
    await user("owner");
    const member = await user("member", { member: true });
    await user("member", { member: true });
    await assign(member, 20);
    await assign(owner, 10);
    expect(await ringIdentities(line)).toEqual([onLine(member), onLine(owner)]);
  });

  test("disabled assignees are skipped and an empty list rings the owners", async () => {
    const firstOwner = await user("owner");
    const secondOwner = await user("owner");
    await user("owner", { enabled: false });
    const working = await user("member", { member: true });
    const disabled = await user("member", { member: true, enabled: false });
    await assign(disabled, 20);
    await assign(working, 10);
    expect(await ringIdentities(line)).toEqual([onLine(working)]);

    // The last assignee is disabled too: the line still rings someone.
    await db.query("UPDATE app_users SET enabled = false WHERE id = $1", [
      working,
    ]);
    expect(await ringIdentities(line)).toEqual([
      onLine(firstOwner),
      onLine(secondOwner),
    ]);

    // An assignee who lost access to the workspace is skipped the same way.
    const outsider = await user("member");
    await db.query(
      "INSERT INTO workspace_members (workspace_id, user_id) VALUES ($1, $2)",
      [OTHER_WORKSPACE, outsider],
    );
    await assign(outsider, 5);
    expect(await ringIdentities(line)).toEqual([
      onLine(firstOwner),
      onLine(secondOwner),
    ]);
  });

  test("no users at all rings today's identity", async () => {
    expect(await ringIdentities(line)).toEqual([
      `connection_${compact(CONNECTION)}`,
    ]);
    expect(await ringIdentities(legacyLine)).toEqual(["iron_wing_desk"]);
    // Members alone are not owners: an unassigned line still rings today's.
    await user("member", { member: true });
    await user("owner", { enabled: false });
    expect(await ringIdentities(line)).toEqual([
      `connection_${compact(CONNECTION)}`,
    ]);
  });

  test("the legacy line rings every owner", async () => {
    const first = await user("owner");
    const second = await user("owner");
    await user("owner", { enabled: false });
    const member = await user("member", { member: true });
    await assign(member, 10);
    const expected = [onLegacy(first), onLegacy(second)];
    expect(await ringIdentities(legacyLine)).toEqual(expected);
    // The legacy route has no provider object at all.
    expect(await ringIdentities(undefined)).toEqual(expected);
  });

  test("at most 10 identities, earliest assignments first", async () => {
    const people = [];
    for (let i = 0; i < 12; i += 1)
      people.push(await user("member", { member: true }));
    // Assigned in reverse creation order, oldest assignment first.
    for (let i = 0; i < people.length; i += 1)
      await assign(people[people.length - 1 - i], 100 - i);
    const expected = people
      .slice()
      .reverse()
      .slice(0, 10)
      .map((id) => onLine(id));
    expect(await ringIdentities(line)).toEqual(expected);
  });

  test("assignees saved in Settings ring in the order given", async () => {
    const {
      setNumberAssignees,
      listConnections,
    } = require("../src/workspaceConnections");
    const owner = await user("owner");
    const member = await user("member", { member: true });
    const outsider = await user("member");
    await expect(
      setNumberAssignees(WORKSPACE, NUMBER, [member, outsider]),
    ).rejects.toThrow("Choose people who can open this workspace.");
    await setNumberAssignees(WORKSPACE, NUMBER, [member, owner]);
    expect(await ringIdentities(line)).toEqual([onLine(member), onLine(owner)]);
    // Saving again keeps existing people in place and drops the removed.
    await setNumberAssignees(WORKSPACE, NUMBER, [owner, member]);
    expect(await ringIdentities(line)).toEqual([onLine(member), onLine(owner)]);
    await setNumberAssignees(WORKSPACE, NUMBER, [owner]);
    expect(await ringIdentities(line)).toEqual([onLine(owner)]);

    // A member who later loses access drops off the list and the ring.
    await setNumberAssignees(WORKSPACE, NUMBER, [owner, member]);
    await db.query("DELETE FROM workspace_members WHERE user_id = $1", [
      member,
    ]);
    const [connection] = await listConnections(WORKSPACE);
    expect(connection.numbers[0]).toMatchObject({
      personal: false,
      assignees: [{ id: owner, displayName: expect.any(String) }],
    });
    expect(await ringIdentities(line)).toEqual([onLine(owner)]);

    await setNumberAssignees(WORKSPACE, NUMBER, []);
    const { rows } = await db.query("SELECT 1 FROM number_assignees");
    expect(rows).toHaveLength(0);
  });
  test("owners may use every line and the legacy line, while enabled", async () => {
    const owner = await user("owner");
    expect(await mayUseLine({ id: owner }, line)).toBe(true);
    expect(await mayUseLine({ id: owner }, legacyLine)).toBe(true);
    expect(await lineRole({ id: owner }, line)).toBe("owner");
    await db.query("UPDATE app_users SET enabled = false WHERE id = $1", [
      owner,
    ]);
    expect(await mayUseLine({ id: owner }, line)).toBe(false);
    expect(await mayUseLine({ id: owner }, legacyLine)).toBe(false);
    // An id with no account at all.
    expect(await mayUseLine({ id: uid() }, line)).toBe(false);
  });

  test("members may use only lines assigned to them in their workspace", async () => {
    const member = await user("member", { member: true });
    expect(await mayUseLine({ id: member }, line)).toBe(false);
    await assign(member, 10);
    expect(await mayUseLine({ id: member }, line)).toBe(true);
    expect(await lineRole({ id: member }, line)).toBe("member");
    // Never the legacy line.
    expect(await mayUseLine({ id: member }, legacyLine)).toBe(false);
    // Losing the workspace loses the line.
    await db.query("DELETE FROM workspace_members WHERE user_id = $1", [
      member,
    ]);
    expect(await mayUseLine({ id: member }, line)).toBe(false);
    await db.query(
      "INSERT INTO workspace_members (workspace_id, user_id) VALUES ($1, $2)",
      [WORKSPACE, member],
    );
    // A disabled member keeps the row but not the line.
    await db.query("UPDATE app_users SET enabled = false WHERE id = $1", [
      member,
    ]);
    expect(await mayUseLine({ id: member }, line)).toBe(false);
  });

  describe("the lines a user may use", () => {
    const SECOND = "00000000-0000-4000-8000-0000000000a5";
    const TEXT_ONLY = "00000000-0000-4000-8000-0000000000a6";
    beforeAll(async () => {
      await db.query(
        `INSERT INTO connection_numbers (id, connection_id, phone_number, voice_enabled, sms_enabled, label)
         VALUES ($1, $3, '+12025550101', true, true, 'Second'),
                ($2, $3, '+12025550102', false, true, 'Texts')`,
        [SECOND, TEXT_ONLY, CONNECTION],
      );
      await db.query(
        "UPDATE connection_numbers SET voice_enabled = true, sms_enabled = true, label = 'Main' WHERE id = $1",
        [NUMBER],
      );
      await db.query(
        "INSERT INTO workspace_active_numbers (workspace_id, connection_number_id) VALUES ($1, $2)",
        [WORKSPACE, SECOND],
      );
    }, 30000);
    const entry = (numberId, phoneNumber, label) => ({
      numberId,
      phoneNumber,
      label,
      legacy: false,
      connectionId: CONNECTION,
    });

    test("an owner gets every voice line, the active one first, then legacy", async () => {
      const previous = process.env.TWILIO_CALLER_ID;
      process.env.TWILIO_CALLER_ID = "+15550000001";
      try {
        const owner = await user("owner");
        expect(
          await usableLines({ id: owner, role: "owner" }, WORKSPACE),
        ).toEqual([
          entry(SECOND, "+12025550101", "Second"),
          entry(NUMBER, "+12025550100", "Main"),
          {
            numberId: null,
            phoneNumber: "+15550000001",
            label: null,
            legacy: true,
            connectionId: null,
          },
        ]);
        expect(
          await usableLines({ id: owner, role: "owner" }, OTHER_WORKSPACE),
        ).toEqual([]);
      } finally {
        if (previous === undefined) delete process.env.TWILIO_CALLER_ID;
        else process.env.TWILIO_CALLER_ID = previous;
      }
    });

    test("a member gets their assigned lines in assignment order, never legacy", async () => {
      const previous = process.env.TWILIO_CALLER_ID;
      process.env.TWILIO_CALLER_ID = "+15550000001";
      try {
        const member = await user("member", { member: true });
        const someone = { id: member, role: "member" };
        expect(await usableLines(someone, WORKSPACE)).toEqual([]);
        await db.query(
          `INSERT INTO number_assignees (number_id, user_id, created_at)
           VALUES ($1, $4, now() - interval '30 seconds'),
                  ($2, $4, now() - interval '20 seconds'),
                  ($3, $4, now() - interval '10 seconds')`,
          [TEXT_ONLY, NUMBER, SECOND, member],
        );
        expect(await usableLines(someone, WORKSPACE)).toEqual([
          entry(NUMBER, "+12025550100", "Main"),
          entry(SECOND, "+12025550101", "Second"),
        ]);
        // For texts, lines without voice count too.
        expect(
          (await usableLines(someone, WORKSPACE, { voiceOnly: false })).map(
            (l) => l.numberId,
          ),
        ).toEqual([TEXT_ONLY, NUMBER, SECOND]);
        // Without the workspace, nothing.
        await db.query("DELETE FROM workspace_members WHERE user_id = $1", [
          member,
        ]);
        expect(await usableLines(someone, WORKSPACE)).toEqual([]);
      } finally {
        if (previous === undefined) delete process.env.TWILIO_CALLER_ID;
        else process.env.TWILIO_CALLER_ID = previous;
      }
    });
  });
});
