// Use a throwaway database with a name ending in _test.
jest.mock("../src/db", () => {
  const { Pool } = require("pg");
  return new Pool({ connectionString: process.env.TEST_DB_URL });
});
jest.mock("../src/twilioConnectionValidation", () => ({}));
jest.mock("twilio", () => jest.fn(() => ({ calls: {}, messages: {} })));
jest.mock("../src/token", () => ({
  accountSid: "ACtest",
  authToken: "test",
  getIdentity: () => "operator",
}));
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const url = process.env.TEST_DB_URL;
const enabled =
  process.env.USERS_PG_TEST === "1" &&
  url &&
  new URL(url).pathname.endsWith("_test");
const suite = enabled ? describe : describe.skip;

suite("Users schema and store against PostgreSQL", () => {
  const workspace = "00000000-0000-4000-8000-000000000001";
  const connection = "00000000-0000-4000-8000-000000000003";
  const numberId = "00000000-0000-4000-8000-000000000004";
  let pool;
  let users;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await pool.query(`
      DROP TABLE IF EXISTS number_assignees, workspace_members, app_users,
        connection_numbers, provider_connections, workspaces CASCADE;
      CREATE TABLE workspaces (id uuid PRIMARY KEY, name text);
      CREATE TABLE provider_connections (
        id uuid PRIMARY KEY, workspace_id uuid);
      CREATE TABLE connection_numbers (
        id uuid PRIMARY KEY, connection_id uuid, phone_number text);
    `);
    const sql = fs.readFileSync(
      path.join(__dirname, "../migrations/014_users.sql"),
      "utf8",
    );
    await pool.query(sql);
    await pool.query(sql);
    await pool.query("INSERT INTO workspaces (id, name) VALUES ($1, 'a')", [
      workspace,
    ]);
    await pool.query(
      "INSERT INTO provider_connections (id, workspace_id) VALUES ($1, $2)",
      [connection, workspace],
    );
    await pool.query(
      `INSERT INTO connection_numbers (id, connection_id, phone_number)
       VALUES ($1, $2, '+12025550100')`,
      [numberId, connection],
    );
    users = require("../src/users");
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (enabled) await require("../src/db").end();
  });

  test("numbers default to not personal", async () => {
    const { rows } = await pool.query(
      "SELECT personal FROM connection_numbers WHERE id = $1",
      [numberId],
    );
    expect(rows[0].personal).toBe(false);
  });

  test("creates an owner and a member with a membership row", async () => {
    const owner = await users.createUser({
      username: "Boss",
      password: "correct horse battery",
      role: "owner",
    });
    expect(owner).toMatchObject({
      username: "boss",
      role: "owner",
      enabled: true,
      workspaceIds: [],
    });
    const member = await users.createUser({
      username: "dispatcher.1",
      displayName: "Dee",
      password: "another long password",
      role: "member",
      workspaceIds: [workspace],
    });
    expect(member.workspaceIds).toEqual([workspace]);
    expect(await users.hasEnabledOwner()).toBe(true);
    expect((await users.listUsers()).map((u) => u.username)).toEqual([
      "boss",
      "dispatcher.1",
    ]);
    expect(
      await users.authenticate("dispatcher.1", "another long password"),
    ).toMatchObject({ id: member.id, workspaceIds: [workspace] });
    expect(
      await users.authenticate("dispatcher.1", "nope nope nope!"),
    ).toBeNull();
    const { rows } = await pool.query(
      "SELECT last_login_at FROM app_users WHERE id = $1",
      [member.id],
    );
    expect(rows[0].last_login_at).not.toBeNull();
  });

  test("a duplicate username is taken", async () => {
    await expect(
      users.createUser({
        username: "BOSS",
        password: "correct horse battery",
        role: "owner",
      }),
    ).rejects.toThrow("That username is taken.");
    let code;
    try {
      await pool.query(
        `INSERT INTO app_users (id, username, display_name, password_hash, role)
         VALUES (gen_random_uuid(), 'boss', 'x', 'x', 'owner')`,
      );
    } catch (error) {
      code = error.code;
    }
    expect(code).toBe("23505");
  });

  test("the only enabled owner cannot be demoted", async () => {
    const owner = (await users.listUsers()).find((u) => u.username === "boss");
    await expect(
      users.updateUser(owner.id, { enabled: false }),
    ).rejects.toThrow("Keep at least one enabled owner.");
  });

  test("deleting a number cascades its assignees", async () => {
    const member = (await users.listUsers()).find(
      (u) => u.username === "dispatcher.1",
    );
    await pool.query(
      "INSERT INTO number_assignees (number_id, user_id) VALUES ($1, $2)",
      [numberId, member.id],
    );
    await pool.query("DELETE FROM connection_numbers WHERE id = $1", [
      numberId,
    ]);
    const { rows } = await pool.query("SELECT 1 FROM number_assignees");
    expect(rows).toHaveLength(0);
  });
  /* The history filter (src/visibility.js) runs against real tables: the
  call history and conversation list queries are EXPLAINed and run for an
  owner and a member. Its own schema, so its minimal call_logs and legs
  tables can't collide with the other PostgreSQL suites. */
  describe("history visibility", () => {
    const schema = "history_visibility_pg_test";
    const W = "00000000-0000-4000-8000-0000000000e1";
    const C = "00000000-0000-4000-8000-0000000000e2";
    const OWNER = "00000000-0000-4000-8000-0000000000e3";
    const MEMBER = "00000000-0000-4000-8000-0000000000e4";
    const SHARED = "+12025550100";
    const PERSONAL = "+12025550199";
    const RELEASED = "+12025550777";
    const EXTERNAL = "+12025550123";
    const hex = (id) => id.replace(/-/g, "");
    let db;
    let spy;
    const saved = {};

    beforeAll(async () => {
      for (const key of ["TWILIO_CALLER_ID", "TWILIO_PREVIOUS_NUMBERS"])
        saved[key] = process.env[key];
      // Not Iron Wing, so the legacy numbers play no part.
      process.env.TWILIO_CALLER_ID = "+12025550000";
      process.env.TWILIO_PREVIOUS_NUMBERS = "";
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.query(`CREATE SCHEMA ${schema}`);
      db = new Pool({
        connectionString: url,
        options: `-c search_path=${schema}`,
      });
      await db.query(`
        CREATE TABLE workspaces (id uuid PRIMARY KEY, name text);
        CREATE TABLE provider_connections (id uuid PRIMARY KEY, workspace_id uuid);
        CREATE TABLE connection_numbers (
          id uuid PRIMARY KEY, connection_id uuid, phone_number text,
          handler text NOT NULL DEFAULT 'softphone');
        CREATE TABLE call_logs (
          id bigserial PRIMARY KEY, call_sid text, timestamp timestamp,
          from_number text, to_number text, status text, duration int,
          direction text, workspace_id uuid, provider_connection_id uuid,
          driver_id int, price numeric, price_unit text);
        CREATE TABLE message_logs (
          id bigserial PRIMARY KEY, message_sid text, from_number text,
          to_number text, body text, timestamp timestamp, workspace_id uuid,
          provider_connection_id uuid, driver_id int);
        CREATE TABLE twilio_call_legs (
          call_sid text, parent_call_sid text, workspace_id uuid,
          provider_connection_id uuid, status text, answered boolean,
          duration int, updated_at timestamptz);
        CREATE TABLE phone_call_sessions (
          id uuid, call_sid text, workspace_id uuid, provider_connection_id uuid,
          from_number text, summary_state text, notes text, outcome text,
          created_at timestamptz DEFAULT now());
        CREATE TABLE call_announcements (
          call_sid text, workspace_id uuid, provider_connection_id uuid,
          kind text, initiated_at timestamptz, completed_at timestamptz);
        CREATE TABLE receptionist_calls (
          call_sid text, claude_cost numeric, relay_cost numeric,
          ended_at timestamptz);
        CREATE TABLE driver (
          id int, first_name text, last_name text, company_id int);
        CREATE TABLE company (id int, name text);
        CREATE TABLE phone_contacts (workspace_id uuid, phone text, name text);
        CREATE TABLE activity_view_settings (
          id boolean PRIMARY KEY, tracking_started_at timestamp);
        CREATE TABLE activity_views (kind text, item_id bigint);
      `);
      await db.query(
        fs.readFileSync(
          path.join(__dirname, "../migrations/014_users.sql"),
          "utf8",
        ),
      );
      await db.query(`
        INSERT INTO workspaces VALUES ('${W}', 'w');
        INSERT INTO provider_connections VALUES ('${C}', '${W}');
        INSERT INTO connection_numbers (id, connection_id, phone_number, personal) VALUES
          (gen_random_uuid(), '${C}', '${SHARED}', false),
          (gen_random_uuid(), '${C}', '${PERSONAL}', true);
        INSERT INTO app_users (id, username, display_name, password_hash, role) VALUES
          ('${OWNER}', 'owner.v', 'O', 'x', 'owner'),
          ('${MEMBER}', 'member.v', 'M', 'x', 'member');
        INSERT INTO workspace_members VALUES ('${W}', '${MEMBER}');
        INSERT INTO number_assignees (number_id, user_id)
          SELECT id, '${MEMBER}'::uuid FROM connection_numbers WHERE phone_number = '${SHARED}'
          UNION ALL
          SELECT id, '${OWNER}'::uuid FROM connection_numbers WHERE phone_number = '${PERSONAL}';
        INSERT INTO activity_view_settings VALUES (true, now() - interval '1 day');
        INSERT INTO call_logs (id, call_sid, timestamp, from_number, to_number, direction, workspace_id) VALUES
          (1, 'CA1', now(), '${EXTERNAL}', '${SHARED}', 'inbound', '${W}'),
          (2, 'CA2', now(), '${EXTERNAL}', '${PERSONAL}', 'inbound', '${W}'),
          (3, 'CA3', now(), '${EXTERNAL}', '${RELEASED}', 'inbound', '${W}'),
          (4, 'CA4', now(), 'client:u${hex(OWNER)}_c${hex(C)}', '${EXTERNAL}', 'inbound', '${W}'),
          (5, 'CA5', now(), 'client:u${hex(MEMBER)}_c${hex(C)}', '${EXTERNAL}', 'inbound', '${W}'),
          (6, 'CA6', now(), '${PERSONAL}', '${EXTERNAL}', 'outbound-api', '${W}');
        INSERT INTO message_logs (id, message_sid, from_number, to_number, body, timestamp, workspace_id) VALUES
          (1, 'SM1', '${EXTERNAL}', '${SHARED}', 'a', now(), '${W}'),
          (2, 'SM2', '${EXTERNAL}', '${PERSONAL}', 'b', now(), '${W}'),
          (3, 'SM3', '${PERSONAL}', '${EXTERNAL}', 'c', now(), '${W}');
      `);
      const dbPool = require("../src/db");
      spy = jest
        .spyOn(dbPool, "query")
        .mockImplementation((...args) => db.query(...args));
    });

    afterAll(async () => {
      if (spy) spy.mockRestore();
      if (db) await db.end();
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    });

    const owner = { id: OWNER, role: "owner" };
    const member = { id: MEMBER, role: "member", workspaceIds: [W] };
    const run = async (handler, user, query = {}) => {
      const res = {
        set: jest.fn(),
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      };
      spy.mockClear();
      await handler({ user, workspace: { id: W }, query }, res);
      expect(res.status).not.toHaveBeenCalled();
      const [sql, params] = spy.mock.calls[spy.mock.calls.length - 1];
      return { rows: res.json.mock.calls[0][0], sql, params };
    };

    test("the filtered call history parses, and a member sees only their lines", async () => {
      const { getCallLogs } = require("../src/logManager");
      const forMember = await run(getCallLogs, member);
      await expect(
        db.query(`EXPLAIN ${forMember.sql}`, forMember.params),
      ).resolves.toBeTruthy();
      expect(forMember.rows.map((row) => row.id).sort()).toEqual(["1", "5"]);
      const forOwner = await run(getCallLogs, owner);
      await expect(
        db.query(`EXPLAIN ${forOwner.sql}`, forOwner.params),
      ).resolves.toBeTruthy();
      expect(forOwner.rows.map((row) => row.id).sort()).toEqual([
        "1",
        "2",
        "3",
        "4",
        "5",
        "6",
      ]);
      const searched = await run(getCallLogs, member, {
        search: PERSONAL.slice(1),
      });
      expect(searched.rows).toEqual([]);
    });

    test("history on a released number is visible to owners only", async () => {
      const { getCallLogs } = require("../src/logManager");
      expect((await run(getCallLogs, owner)).rows.map((r) => r.id)).toContain(
        "3",
      );
      expect(
        (await run(getCallLogs, member)).rows.map((r) => r.id),
      ).not.toContain("3");
    });

    test("another owner does not see a personal line or calls placed from it", async () => {
      const { getCallLogs } = require("../src/logManager");
      const other = "00000000-0000-4000-8000-0000000000e5";
      await db.query(
        `INSERT INTO app_users (id, username, display_name, password_hash, role)
         VALUES ($1, 'owner.two', 'P', 'x', 'owner')`,
        [other],
      );
      const { rows } = await run(getCallLogs, { id: other, role: "owner" });
      expect(rows.map((row) => row.id).sort()).toEqual(["1", "3", "5"]);
    });

    test("the filtered conversation list parses, and a member sees only their lines", async () => {
      const { list } = require("../src/conversations");
      const forMember = await run(list, member);
      await expect(
        db.query(`EXPLAIN ${forMember.sql}`, forMember.params),
      ).resolves.toBeTruthy();
      expect(forMember.rows.map((row) => row.local_number)).toEqual([SHARED]);
      const forOwner = await run(list, owner);
      expect(forOwner.rows.map((row) => row.local_number).sort()).toEqual([
        SHARED,
        PERSONAL,
      ]);
    });

    test("a Live Assist session on the personal line is not found by a member", async () => {
      const router = require("../src/callAssist/routes");
      const layer = router.stack.find(
        (l) => l.route && l.route.path === "/sessions/:sessionId",
      );
      const handle = layer.route.stack[layer.route.stack.length - 1].handle;
      const session = "00000000-0000-4000-8000-0000000000e6";
      await db.query(
        `INSERT INTO phone_call_sessions (id, workspace_id, from_number)
         VALUES ($1, $2, $3)`,
        [session, W, PERSONAL],
      );
      const res = { sendStatus: jest.fn(), json: jest.fn() };
      spy.mockClear();
      await handle(
        { user: member, workspace: { id: W }, params: { sessionId: session } },
        res,
      );
      expect(res.sendStatus).toHaveBeenCalledWith(404);
      const [sql, params] = spy.mock.calls[spy.mock.calls.length - 1];
      await expect(db.query(`EXPLAIN ${sql}`, params)).resolves.toBeTruthy();
      // The owner, whose line it is, gets it.
      const shown = { sendStatus: jest.fn(), json: jest.fn() };
      await handle(
        { user: owner, workspace: { id: W }, params: { sessionId: session } },
        shown,
      );
      expect(shown.sendStatus).not.toHaveBeenCalled();
      expect(shown.json.mock.calls[0][0]).toMatchObject({ id: session });
    });

    test("leads follow the dialed line's visibility; a lead with no call row is owners only", async () => {
      const store = require("../src/receptionist/store");
      const { lineScope } = require("../src/visibility");
      // The fuller receptionist_calls the leads queries read.
      await db.query(`
        ALTER TABLE receptionist_calls
          ADD COLUMN workspace_id uuid, ADD COLUMN from_number text,
          ADD COLUMN started_at timestamptz, ADD COLUMN outcome text,
          ADD COLUMN status text NOT NULL DEFAULT 'new',
          ADD COLUMN handled_at timestamptz, ADD COLUMN caller_name text,
          ADD COLUMN company text, ADD COLUMN mc_number text,
          ADD COLUMN usdot text, ADD COLUMN mc_verified boolean,
          ADD COLUMN callback_number text, ADD COLUMN callback_promise text,
          ADD COLUMN carrier jsonb, ADD COLUMN details jsonb,
          ADD COLUMN summary text, ADD COLUMN script jsonb,
          ADD COLUMN transcript jsonb, ADD COLUMN agent_profile_id uuid;
        CREATE TABLE agent_profiles (
          id uuid, workspace_id uuid, kind text, persona_name text);
        INSERT INTO receptionist_calls
          (call_sid, workspace_id, from_number, started_at, ended_at, outcome)
        VALUES
          ('CA1', '${W}', '${EXTERNAL}', now(), now(), 'lead'),
          ('CA2', '${W}', '${EXTERNAL}', now(), now(), 'lead'),
          ('CA9', '${W}', '${EXTERNAL}', now(), now(), 'lead');
      `);
      const sids = (rows) => rows.map((row) => row.call_sid).sort();
      const forMember = await lineScope(member, W);
      const forOwner = await lineScope(owner, W);
      // CA1 is on the member's line, CA2 on the owner's personal line, and
      // CA9 has no call_logs row.
      expect(sids(await store.listCalls(W, forMember))).toEqual(["CA1"]);
      expect(sids(await store.listCalls(W, forOwner))).toEqual([
        "CA1",
        "CA2",
        "CA9",
      ]);
      expect(await store.countNew(W, forMember)).toBe(1);
      expect(await store.countNew(W, forOwner)).toBe(3);
      // No scope at all sees nothing.
      expect(await store.listCalls(W, undefined)).toEqual([]);
      expect(await store.setStatus(W, "CA2", "called", forMember)).toBe(false);
      expect(await store.setStatus(W, "CA9", "called", forMember)).toBe(false);
      expect(await store.setStatus(W, "CA1", "called", forMember)).toBe(true);
      expect(await store.setStatus(W, "CA9", "called", forOwner)).toBe(true);
      const { rows } = await db.query(
        "SELECT call_sid, status FROM receptionist_calls ORDER BY call_sid",
      );
      expect(rows).toEqual([
        { call_sid: "CA1", status: "called" },
        { call_sid: "CA2", status: "new" },
        { call_sid: "CA9", status: "called" },
      ]);
    });

    test("unread counts count only the member's lines", async () => {
      const { counts } = require("../src/activityViews");
      expect((await run(counts, member)).rows).toEqual({
        calls: 1,
        messages: 1,
      });
      expect((await run(counts, owner)).rows).toEqual({
        calls: 3,
        messages: 2,
      });
    });

    /* A softphone call (from client:<identity>) is judged by the line it
    used: its child leg's from_number. Last, so the other tests' rows and
    counts are untouched. */
    test("softphone calls follow the line they used", async () => {
      const { getCallLogs } = require("../src/logManager");
      const IW = "00000000-0000-4000-8000-000000000001";
      const IWC = "00000000-0000-4000-8000-0000000000e7";
      const LEGACY = "+12025550000";
      const fromOwner = `client:u${hex(OWNER)}_c${hex(C)}`;
      // Parent and child legs: the child's from_number is the line used.
      const call = (id, sid, ws, from, line) => `
        INSERT INTO call_logs (id, call_sid, timestamp, from_number, to_number, direction, workspace_id) VALUES
          (${id}, '${sid}', now(), '${from}', '${EXTERNAL}', 'inbound', '${ws}'),
          (${id + 100}, '${sid}c', now(), '${line}', '${EXTERNAL}', 'outbound-dial', '${ws}');
        INSERT INTO twilio_call_legs VALUES
          ('${sid}c', '${sid}', '${ws}', NULL, 'completed', true, 5, now());`;
      await db.query(`
        ${call(10, "CS10", W, fromOwner, SHARED)}
        ${call(11, "CS11", W, fromOwner, PERSONAL)}
        ${call(12, "CS12", W, fromOwner, "anonymous")}
        INSERT INTO workspaces VALUES ('${IW}', 'iron wing');
        INSERT INTO provider_connections VALUES ('${IWC}', '${IW}');
        ${call(13, "CS13", IW, `client:u${hex(OWNER)}_c${hex(IWC)}`, LEGACY)}
      `);
      const other = {
        id: "00000000-0000-4000-8000-0000000000e5",
        role: "owner",
      };
      const ids = (result) => result.rows.map((row) => row.id).sort();
      const forOther = await run(getCallLogs, other);
      await expect(
        db.query(`EXPLAIN ${forOther.sql}`, forOther.params),
      ).resolves.toBeTruthy();
      // Owner B sees owner A's call from the shared line, though A's only
      // line on the connection is personal; not the one from A's personal
      // line. With no E.164 line (CS12) or no child leg (4) the caller's
      // identity decides, as before.
      expect(ids(forOther)).toEqual(["1", "10", "3", "5"]);
      expect(forOther.rows.find((row) => row.id === "10").local_number).toBe(
        SHARED,
      );
      // The member sees it on their shared line too, never the personal one.
      const forMember = await run(getCallLogs, member);
      expect(ids(forMember)).toEqual(["1", "10", "5"]);
      // A's own calls, and the owner of every line, still see them all.
      expect(ids(await run(getCallLogs, owner))).toEqual([
        "1",
        "10",
        "11",
        "12",
        "2",
        "3",
        "4",
        "5",
        "6",
      ]);
      // An Iron Wing member sees the owner's call on the legacy line.
      const res = { set: jest.fn(), json: jest.fn(), status: jest.fn() };
      await getCallLogs(
        { user: member, workspace: { id: IW }, query: {} },
        res,
      );
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json.mock.calls[0][0].map((row) => row.id)).toEqual(["13"]);
    });

    test("an owner's own softphone call from a line hidden from them still shows to them", async () => {
      const { getCallLogs } = require("../src/logManager");
      // Owner C's staffed personal line, hidden from owners A and B. A can
      // still place a call on the connection that shows it as caller ID.
      const OWNER_C = "00000000-0000-4000-8000-0000000000e8";
      const PERSONAL_C = "+12025550198";
      await db.query(`
        INSERT INTO app_users (id, username, display_name, password_hash, role) VALUES
          ('${OWNER_C}', 'owner.c', 'C', 'x', 'owner');
        INSERT INTO connection_numbers (id, connection_id, phone_number, personal) VALUES
          (gen_random_uuid(), '${C}', '${PERSONAL_C}', true);
        INSERT INTO number_assignees (number_id, user_id)
          SELECT id, '${OWNER_C}'::uuid FROM connection_numbers WHERE phone_number = '${PERSONAL_C}';
        INSERT INTO call_logs (id, call_sid, timestamp, from_number, to_number, direction, workspace_id) VALUES
          (14, 'CS14', now(), 'client:u${hex(OWNER)}_c${hex(C)}', '${EXTERNAL}', 'inbound', '${W}'),
          (114, 'CS14c', now(), '${PERSONAL_C}', '${EXTERNAL}', 'outbound-dial', '${W}');
        INSERT INTO twilio_call_legs VALUES
          ('CS14c', 'CS14', '${W}', NULL, 'completed', true, 5, now());
      `);
      const ids = (result) => result.rows.map((row) => row.id);
      const forA = await run(getCallLogs, owner);
      await expect(
        db.query(`EXPLAIN ${forA.sql}`, forA.params),
      ).resolves.toBeTruthy();
      expect(ids(forA)).toContain("14");
      const other = {
        id: "00000000-0000-4000-8000-0000000000e5",
        role: "owner",
      };
      expect(ids(await run(getCallLogs, other))).not.toContain("14");
      expect(ids(await run(getCallLogs, member))).not.toContain("14");
    });

    /* The contact timeline on real rows (Review Focus 2 and 5). Last, so
    the other tests' rows and counts are untouched; the callers here are
    numbers no other test uses. */
    describe("contact timeline", () => {
      const TL = "+12025550444";
      const TIE = "+12025550555";
      const S = (n) =>
        `00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;
      let handle;

      beforeAll(async () => {
        const contacts = require("../src/contacts");
        const layer = contacts.stack.find(
          (l) => l.route && l.route.path === "/:phone/timeline",
        );
        handle = layer.route.stack[layer.route.stack.length - 1].handle;
        await db.query(`
          ALTER TABLE phone_call_sessions
            ADD COLUMN IF NOT EXISTS destination text,
            ADD COLUMN IF NOT EXISTS summary jsonb;
          ALTER TABLE phone_contacts ADD COLUMN IF NOT EXISTS company text;
          ALTER TABLE receptionist_calls
            ADD COLUMN IF NOT EXISTS workspace_id uuid,
            ADD COLUMN IF NOT EXISTS from_number text,
            ADD COLUMN IF NOT EXISTS started_at timestamptz,
            ADD COLUMN IF NOT EXISTS outcome text,
            ADD COLUMN IF NOT EXISTS callback_number text,
            ADD COLUMN IF NOT EXISTS summary text;
        `);
      });

      const fetch = async (user, phone, query = {}) => {
        const res = {
          json: jest.fn(),
          status: jest.fn().mockReturnThis(),
        };
        spy.mockClear();
        await handle(
          { user, workspace: { id: W }, params: { phone }, query },
          res,
        );
        expect(res.status).not.toHaveBeenCalled();
        const [sql, params] = spy.mock.calls.find(([text]) =>
          text.includes("UNION ALL"),
        );
        await expect(db.query(`EXPLAIN ${sql}`, params)).resolves.toBeTruthy();
        return res.json.mock.calls[0][0];
      };
      const keys = (body) => body.entries.map((e) => `${e.kind}:${e.id}`);

      test("a member sees nothing of the owner's personal line", async () => {
        await db.query(`
          INSERT INTO phone_contacts (workspace_id, phone, name, company)
            VALUES ('${W}', '${TL}', 'Tara Lane', 'Lane Freight');
          INSERT INTO call_logs (id, call_sid, timestamp, from_number, to_number, status, duration, direction, workspace_id) VALUES
            (20, 'CT20', now() - interval '1 hour', '${TL}', '${SHARED}', 'completed', 95, 'inbound', '${W}'),
            (21, 'CT21', now() - interval '2 hours', '${TL}', '${PERSONAL}', 'completed', 600, 'inbound', '${W}'),
            (22, 'CT22', now() - interval '3 hours', '${PERSONAL}', '${TL}', 'completed', 300, 'outbound-api', '${W}');
          INSERT INTO twilio_call_legs VALUES
            ('CT20c', 'CT20', '${W}', NULL, 'completed', true, 95, now());
          INSERT INTO message_logs (id, message_sid, from_number, to_number, body, timestamp, workspace_id) VALUES
            (20, 'SMT20', '${TL}', '${SHARED}', 'shared hello', now() - interval '4 hours', '${W}'),
            (21, 'SMT21', '${TL}', '${PERSONAL}', 'secret one', now() - interval '5 hours', '${W}'),
            (22, 'SMT22', '${PERSONAL}', '${TL}', 'secret two', now() - interval '6 hours', '${W}');
          INSERT INTO receptionist_calls (call_sid, workspace_id, from_number, callback_number, started_at, ended_at, outcome, summary) VALUES
            ('CT20', '${W}', '${TL}', NULL, now() - interval '1 hour', now(), 'lead', 'Needs a reefer'),
            ('CT21', '${W}', '${TL}', NULL, now() - interval '2 hours', now(), 'urgent', 'secret three'),
            ('CT29', '${W}', 'anonymous', '${TL}', now() - interval '7 hours', now(), 'message', 'secret four');
          INSERT INTO phone_call_sessions (id, call_sid, workspace_id, from_number, destination, notes, summary, created_at) VALUES
            ('${S(1)}', NULL, '${W}', '${SHARED}', '${TL}', 'shared note', NULL, now() - interval '8 hours'),
            ('${S(2)}', NULL, '${W}', '${PERSONAL}', '${TL}', 'secret five', NULL, now() - interval '9 hours'),
            ('${S(3)}', 'CT21', '${W}', '${SHARED}', '${TL}', '', '{"reason": "secret six"}', now() - interval '10 hours');
        `);
        const forMember = await fetch(member, TL);
        expect(keys(forMember)).toEqual([
          "agent_call:CT20",
          "call:20",
          "text:20",
          `assist:${S(1)}`,
        ]);
        expect(forMember.contact).toEqual({
          name: "Tara Lane",
          company: "Lane Freight",
        });
        expect(forMember.next).toBeNull();
        expect(forMember.entries.map((e) => e.summary)).toEqual([
          "New lead: Needs a reefer",
          "Answered · 2 min",
          "shared hello",
          "shared note",
        ]);
        expect(forMember.entries.every((e) => e.line === SHARED)).toBe(true);
        // Nothing of the personal line, in any field.
        const sent = JSON.stringify(forMember);
        expect(sent).not.toContain(PERSONAL);
        expect(sent).not.toContain("secret");
        expect(sent).not.toContain("CT21");
        expect(sent).not.toContain("CT22");
        // Paging by one never reaches a hidden row either.
        const seen = [];
        let cursor;
        do {
          const page = await fetch(
            member,
            TL,
            cursor ? { limit: "1", cursor } : { limit: "1" },
          );
          seen.push(...keys(page));
          cursor = page.next;
        } while (cursor);
        expect(seen).toEqual(keys(forMember));
        // The owner, whose personal line it is, sees everything.
        const forOwner = await fetch(owner, TL);
        expect(keys(forOwner).sort()).toEqual(
          [
            "agent_call:CT20",
            "agent_call:CT21",
            "agent_call:CT29",
            "call:20",
            "call:21",
            "call:22",
            "text:20",
            "text:21",
            "text:22",
            `assist:${S(1)}`,
            `assist:${S(2)}`,
            `assist:${S(3)}`,
          ].sort(),
        );
        const byKey = Object.fromEntries(
          forOwner.entries.map((e) => [`${e.kind}:${e.id}`, e]),
        );
        expect(byKey["call:22"]).toMatchObject({
          direction: "outbound",
          line: PERSONAL,
          summary: "Outgoing call · 5 min",
        });
        expect(byKey["text:22"]).toMatchObject({
          direction: "outbound",
          line: PERSONAL,
        });
        expect(byKey[`assist:${S(3)}`]).toMatchObject({
          summary: "secret six",
          link: { view: "call", callSid: "CT21" },
        });
        expect(byKey["agent_call:CT29"]).toMatchObject({
          summary: "Message: secret four",
          link: { view: "leads", callSid: "CT29" },
          line: null,
        });
      });

      test("entries at the same instant page without gaps or repeats", async () => {
        await db.query(`
          INSERT INTO call_logs (id, call_sid, timestamp, from_number, to_number, status, duration, direction, workspace_id) VALUES
            (30, 'CT30', '2026-01-01 12:00:00.123456', '${TIE}', '${SHARED}', 'completed', 0, 'inbound', '${W}');
          INSERT INTO message_logs (id, message_sid, from_number, to_number, body, timestamp, workspace_id) VALUES
            (30, 'SMT30', '${TIE}', '${SHARED}', 'one', '2026-01-01 12:00:00.123456', '${W}'),
            (31, 'SMT31', '${SHARED}', '${TIE}', 'two', '2026-01-01 12:00:00.123456', '${W}');
          INSERT INTO receptionist_calls (call_sid, workspace_id, from_number, started_at, ended_at, outcome, summary) VALUES
            ('CT30', '${W}', '${TIE}', '2026-01-01 12:00:00.123456+00', now(), 'spam', NULL);
          INSERT INTO phone_call_sessions (id, call_sid, workspace_id, from_number, destination, notes, created_at) VALUES
            ('${S(30)}', NULL, '${W}', '${SHARED}', '${TIE}', '', '2026-01-01 12:00:00.123456+00');
        `);
        const all = await fetch(member, TIE);
        expect(keys(all)).toEqual([
          "agent_call:CT30",
          `assist:${S(30)}`,
          "call:30",
          "text:31",
          "text:30",
        ]);
        expect(new Set(all.entries.map((e) => e.at)).size).toBe(1);
        const seen = [];
        let cursor;
        let pages = 0;
        do {
          const page = await fetch(
            member,
            TIE,
            cursor ? { limit: "1", cursor } : { limit: "1" },
          );
          expect(page.entries).toHaveLength(1);
          seen.push(...keys(page));
          cursor = page.next;
          pages += 1;
        } while (cursor && pages < 10);
        expect(pages).toBe(5);
        expect(seen).toEqual(keys(all));
        // Two at a time, the last page is short and ends the list.
        const first = await fetch(member, TIE, { limit: "2" });
        const second = await fetch(member, TIE, {
          limit: "2",
          cursor: first.next,
        });
        const third = await fetch(member, TIE, {
          limit: "2",
          cursor: second.next,
        });
        expect([...keys(first), ...keys(second), ...keys(third)]).toEqual(
          keys(all),
        );
        expect(third.next).toBeNull();
      });
    });
  });
});
