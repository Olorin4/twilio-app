// Use a throwaway database with a name ending in _test.
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
});
