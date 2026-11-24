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

  // Answers the login lookup (by username) and the hit re-check (by id).
  const serve = (getRow) =>
    pool.query.mockImplementation(async (sql) =>
      /FROM app_users/.test(sql) && /SELECT/.test(sql)
        ? { rows: [getRow()] }
        : { rows: [] },
    );
  const scrypts = () => {
    const spy = jest.spyOn(require("crypto"), "scrypt");
    return spy;
  };

  test("caches success for 5 minutes, re-checking the row on a hit", async () => {
    jest.useFakeTimers();
    try {
      serve(() => rowWithHash());
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
      const updates = () =>
        pool.query.mock.calls.filter(
          ([s]) => /last_login_at/.test(s) && /UPDATE/.test(s),
        ).length;
      expect(updates()).toBe(1);

      pool.query.mockClear();
      const spy = scrypts();
      const second = await users.authenticate("nick", password);
      expect(second).toEqual(first);
      expect(second.workspaceIds).not.toBe(first.workspaceIds);
      expect(spy).not.toHaveBeenCalled(); // no scrypt on a hit
      spy.mockRestore();
      expect(pool.query).toHaveBeenCalledTimes(1);
      expect(pool.query.mock.calls[0][1]).toEqual([UID]);
      expect(updates()).toBe(0);

      jest.advanceTimersByTime(6 * 60 * 1000);
      pool.query.mockClear();
      await users.authenticate("nick", password);
      expect(updates()).toBe(1);

      pool.query.mockClear();
      users.clearAuthCache();
      await users.authenticate("nick", password);
      expect(updates()).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  // A hit that passes its row re-check slides the expiry to now plus 5
  // minutes, so someone working steadily is never pushed back to scrypt (and
  // the sign-in limiter) mid-shift.
  test("an active session survives a limit", async () => {
    jest.useFakeTimers();
    try {
      serve(() => rowWithHash());
      await users.authenticate("nick", password);
      const spy = scrypts();
      for (let i = 0; i < 2; i += 1) {
        jest.advanceTimersByTime(4 * 60 * 1000);
        expect(users.isCachedLogin("nick", password)).toBe(true);
        pool.query.mockClear();
        const user = await users.authenticate("nick", password);
        expect(user.username).toBe("nick");
        // One query: the re-check by id. No lookup, no last_login update.
        expect(pool.query).toHaveBeenCalledTimes(1);
        expect(pool.query.mock.calls[0][1]).toEqual([UID]);
        expect(spy).not.toHaveBeenCalled();
      }
      spy.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a hit whose re-check fails is not extended", async () => {
    jest.useFakeTimers();
    try {
      let row = rowWithHash();
      serve(() => row);
      await users.authenticate("nick", password);
      jest.advanceTimersByTime(4 * 60 * 1000);
      // A database error on the re-check: 503, and the expiry stays put.
      pool.query.mockRejectedValueOnce(new Error("db down"));
      await expect(users.authenticate("nick", password)).rejects.toThrow(
        "db down",
      );
      jest.advanceTimersByTime(90 * 1000);
      expect(users.isCachedLogin("nick", password)).toBe(false);

      // A mismatched re-check removes the entry at once.
      await users.authenticate("nick", password);
      expect(users.isCachedLogin("nick", password)).toBe(true);
      row = rowWithHash({ enabled: false });
      expect(await users.authenticate("nick", password)).toBeNull();
      expect(users.isCachedLogin("nick", password)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a hit refreshes workspace ids from the row", async () => {
    let row = rowWithHash();
    serve(() => row);
    await users.authenticate("nick", password);
    row = rowWithHash({ workspace_ids: ["w9"] });
    expect((await users.authenticate("nick", password)).workspaceIds).toEqual([
      "w9",
    ]);
  });

  test("a password reset in another process is honoured", async () => {
    let row = rowWithHash();
    serve(() => row);
    await users.authenticate("nick", password);
    row = {
      ...rowWithHash(),
      password_hash: await users.hashPassword("brand new password"),
    };
    expect(await users.authenticate("nick", password)).toBeNull();
    expect(
      await users.authenticate("nick", "brand new password"),
    ).not.toBeNull();
  });

  test("a disable in another process is honoured", async () => {
    let row = rowWithHash();
    serve(() => row);
    await users.authenticate("nick", password);
    row = rowWithHash({ enabled: false });
    expect(await users.authenticate("nick", password)).toBeNull();
  });

  test("a role change in another process is honoured", async () => {
    let row = rowWithHash();
    serve(() => row);
    await users.authenticate("nick", password);
    row = rowWithHash({ role: "member" });
    expect((await users.authenticate("nick", password)).role).toBe("member");
  });

  // A DB blip must answer 503, not 401: a 401 pops the browser's login
  // dialog for every signed-in user. Still fails closed (no user).
  test("a database error on the hit check throws, so the login answers 503", async () => {
    serve(() => rowWithHash());
    await users.authenticate("nick", password);
    pool.query.mockRejectedValue(new Error("db down"));
    await expect(users.authenticate("nick", password)).rejects.toThrow(
      "db down",
    );
  });

  test("a login that started before clearAuthCache is not cached", async () => {
    let first = true;
    serve(() => {
      if (first) users.clearAuthCache(); // a commit lands mid-login
      first = false;
      return rowWithHash();
    });
    await users.authenticate("nick", password);
    pool.query.mockClear();
    await users.authenticate("nick", password);
    // Not a hit: a full lookup by username ran again.
    expect(pool.query.mock.calls[0][1]).toEqual(["nick"]);
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

test("an uppercase id cannot bypass the last-owner guard", async () => {
  const { calls } = mockClient((sql) => {
    if (/FOR UPDATE/.test(sql) && /role = 'owner'/.test(sql))
      return { rows: [{ id: UID }] };
    if (/FROM app_users/.test(sql)) return { rows: [dbRow()] };
  });
  await expect(
    users.updateUser(UID.toUpperCase(), { enabled: false }),
  ).rejects.toThrow("Keep at least one enabled owner.");
  expect(calls).toContain("ROLLBACK");
});

test("setPassword and getUser reject malformed ids cleanly", async () => {
  await expect(
    users.setPassword("nope", "correct horse battery"),
  ).rejects.toThrow("User does not exist.");
  expect(await users.getUser("nope")).toBeNull();
  expect(pool.query).not.toHaveBeenCalled();
});
