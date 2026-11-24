jest.mock("../src/db", () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock("../src/twilioConnectionValidation", () => ({}));
const pool = require("../src/db");
const users = require("../src/users");

const UID = "00000000-0000-4000-8000-0000000000a1";
const dbRow = (over = {}) => ({
  id: UID,
  username: "nick",
  display_name: "Nick",
  role: "owner",
  enabled: true,
  workspace_ids: [],
  ...over,
});

// A client whose answers are chosen by the SQL text.
function mockClient(answer) {
  const calls = [];
  const client = {
    query: jest.fn(async (sql, params) => {
      calls.push(sql);
      return answer(sql, params) || { rows: [] };
    }),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValue(client);
  return { client, calls };
}

beforeEach(() => {
  jest.resetAllMocks();
  users.clearAuthCache();
});

test("hashes verify and wrong passwords do not", async () => {
  const hash = await users.hashPassword("correct horse battery");
  expect(hash).toMatch(/^scrypt\$16384\$8\$1\$/);
  expect(await users.verifyPassword("correct horse battery", hash)).toBe(true);
  expect(await users.verifyPassword("wrong horse battery!", hash)).toBe(false);
  expect(await users.verifyPassword("x", "garbage")).toBe(false);
});

test("usernames are lowercased and validated", () => {
  expect(users.normalizeUsername(" Nick.K ")).toBe("nick.k");
  expect(() => users.normalizeUsername("Ab")).toThrow(/^Enter a username/);
  expect(() => users.normalizeUsername("bad name")).toThrow(
    /^Enter a username/,
  );
  expect(() => users.normalizeUsername("a".repeat(41))).toThrow(
    /^Enter a username/,
  );
});

test("passwords outside 12-200 characters are rejected", async () => {
  const message = "Enter a password of 12 to 200 characters.";
  await expect(users.hashPassword("short")).rejects.toThrow(message);
  await expect(users.hashPassword("x".repeat(201))).rejects.toThrow(message);
  await expect(users.hashPassword("x".repeat(12))).resolves.toMatch(
    /^scrypt\$/,
  );
  await expect(users.hashPassword("x".repeat(200))).resolves.toMatch(
    /^scrypt\$/,
  );
  await expect(
    users.createUser({ username: "nick", password: "short", role: "owner" }),
  ).rejects.toThrow(message);
});

describe("authenticate", () => {
  const password = "correct horse battery";
  let hash;
  beforeAll(async () => {
    hash = await users.hashPassword(password);
  });
  const rowWithHash = (over) => ({ ...dbRow(over), password_hash: hash });

  test("caches success for 5 minutes and clearAuthCache drops it", async () => {
    jest.useFakeTimers();
    try {
      pool.query.mockImplementation(async (sql) =>
        /FROM app_users/.test(sql) && /SELECT/.test(sql)
          ? { rows: [rowWithHash()] }
          : { rows: [] },
      );
      const first = await users.authenticate("Nick", password);
      expect(first).toEqual({
        id: UID,
        username: "nick",
        displayName: "Nick",
        role: "owner",
        enabled: true,
        workspaceIds: [],
      });
      expect(first.passwordHash).toBeUndefined();
      const callsAfterFirst = pool.query.mock.calls.length;
      expect(callsAfterFirst).toBeGreaterThan(0);
      expect(
        pool.query.mock.calls.filter(
          ([s]) => /last_login_at/.test(s) && /UPDATE/.test(s),
        ),
      ).toHaveLength(1);

      await users.authenticate("nick", password);
      expect(pool.query.mock.calls.length).toBe(callsAfterFirst);

      jest.advanceTimersByTime(4 * 60 * 1000);
      await users.authenticate("nick", password);
      expect(pool.query.mock.calls.length).toBe(callsAfterFirst);

      jest.advanceTimersByTime(2 * 60 * 1000);
      await users.authenticate("nick", password);
      expect(pool.query.mock.calls.length).toBeGreaterThan(callsAfterFirst);

      const before = pool.query.mock.calls.length;
      users.clearAuthCache();
      await users.authenticate("nick", password);
      expect(pool.query.mock.calls.length).toBeGreaterThan(before);
    } finally {
      jest.useRealTimers();
    }
  });

  test("wrong password, unknown user and bad username return null", async () => {
    pool.query.mockResolvedValueOnce({ rows: [rowWithHash()] });
    expect(await users.authenticate("nick", "wrong password here")).toBeNull();
    pool.query.mockResolvedValueOnce({ rows: [] });
    expect(await users.authenticate("nobody", password)).toBeNull();
    expect(await users.authenticate("A", password)).toBeNull();
  });

  test("a disabled user cannot authenticate", async () => {
    pool.query.mockResolvedValue({ rows: [rowWithHash({ enabled: false })] });
    expect(await users.authenticate("nick", password)).toBeNull();
    expect(pool.query.mock.calls.some(([s]) => /UPDATE/.test(s))).toBe(false);
  });
});

describe("the last enabled owner", () => {
  // The user being edited is the only enabled owner.
  const sole = () =>
    mockClient((sql) => {
      if (/FOR UPDATE/.test(sql) && /role = 'owner'/.test(sql))
        return { rows: [{ id: UID }] };
      if (/FROM app_users/.test(sql) && /WHERE u?\.?id = \$1/.test(sql))
        return { rows: [dbRow()] };
    });

  test("cannot be demoted", async () => {
    const { calls } = sole();
    await expect(users.updateUser(UID, { role: "member" })).rejects.toThrow(
      "Keep at least one enabled owner.",
    );
    expect(calls).toContain("ROLLBACK");
  });

  test("cannot be disabled", async () => {
    sole();
    await expect(users.updateUser(UID, { enabled: false })).rejects.toThrow(
      "Keep at least one enabled owner.",
    );
  });

  test("can be demoted when another enabled owner exists", async () => {
    mockClient((sql) => {
      if (/FOR UPDATE/.test(sql) && /role = 'owner'/.test(sql))
        return { rows: [{ id: UID }, { id: "other" }] };
      if (/FROM app_users/.test(sql))
        return { rows: [dbRow({ role: "member" })] };
    });
    const user = await users.updateUser(UID, { role: "member" });
    expect(user.role).toBe("member");
  });

  test("unknown user", async () => {
    mockClient(() => undefined);
    await expect(users.updateUser(UID, { enabled: false })).rejects.toThrow(
      "User does not exist.",
    );
  });
});

test("listUsers never returns password hashes", async () => {
  pool.query.mockResolvedValue({
    rows: [
      { ...dbRow(), password_hash: "scrypt$secret", workspace_ids: ["w1"] },
    ],
  });
  const list = await users.listUsers();
  expect(list).toEqual([
    {
      id: UID,
      username: "nick",
      displayName: "Nick",
      role: "owner",
      enabled: true,
      workspaceIds: ["w1"],
    },
  ]);
  expect(JSON.stringify(list)).not.toMatch(/scrypt|password/i);
  expect(pool.query.mock.calls[0][0]).not.toMatch(/password_hash/);
});

test("a duplicate username becomes That username is taken.", async () => {
  mockClient((sql) => {
    if (/INSERT INTO app_users/.test(sql))
      throw Object.assign(new Error("dup"), { code: "23505" });
  });
  await expect(
    users.createUser({
      username: "nick",
      password: "correct horse battery",
      role: "owner",
    }),
  ).rejects.toThrow("That username is taken.");
});

test("hasEnabledOwner reads the table", async () => {
  pool.query.mockResolvedValue({ rows: [{ exists: true }] });
  expect(await users.hasEnabledOwner()).toBe(true);
});

test("setPassword rejects a short password and an unknown user", async () => {
  await expect(users.setPassword(UID, "short")).rejects.toThrow(/12 to 200/);
  pool.query.mockResolvedValue({ rowCount: 0, rows: [] });
  await expect(users.setPassword(UID, "correct horse battery")).rejects.toThrow(
    "User does not exist.",
  );
});
