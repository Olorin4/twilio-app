/* Failed logins can't saturate libuv's thread pool: at most two scrypt
verifications run at once, a few more wait briefly, and the rest are refused
as busy instead of hanging. crypto.scrypt is replaced by a controllable fake,
so the test sees exactly how many run at once. */
jest.mock("../src/db", () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock("../src/twilioConnectionValidation", () => ({}));
const running = { active: 0, peak: 0, finish: [] };
jest.mock("crypto", () => {
  const real = jest.requireActual("crypto");
  return {
    ...real,
    scrypt: (password, salt, length, options, callback) => {
      running.active += 1;
      running.peak = Math.max(running.peak, running.active);
      running.finish.push(() => {
        running.active -= 1;
        callback(null, Buffer.alloc(length)); // never matches the stored hash
      });
    },
  };
});
const pool = require("../src/db");
const users = require("../src/users");

const UID = "11111111-1111-4111-8111-111111111111";
const stored = `scrypt$16384$8$1$${Buffer.alloc(16).toString("base64")}$${Buffer.alloc(64, 1).toString("base64")}`;
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  running.active = 0;
  running.peak = 0;
  running.finish = [];
  pool.query.mockResolvedValue({
    rows: [
      {
        id: UID,
        username: "nick",
        display_name: "Nick",
        role: "owner",
        enabled: true,
        workspace_ids: [],
        password_hash: stored,
      },
    ],
  });
});

test("at most two verifications run at once; past the queue, logins are busy", async () => {
  expect(users.MAX_VERIFYING).toBe(2);
  const attempts = Array.from({ length: 12 }, (_, i) =>
    users.authenticate("nick", `wrong password ${i}`).then(
      (value) => ({ value }),
      (error) => ({ error }),
    ),
  );
  await flush();
  expect(running.active).toBe(2);
  // Drain the queue one verification at a time.
  while (running.finish.length) {
    running.finish.shift()();
    await flush();
    expect(running.active).toBeLessThanOrEqual(2);
  }
  const results = await Promise.all(attempts);
  expect(running.peak).toBe(2);
  const busy = results.filter((r) => r.error?.code === "LOGIN_BUSY");
  expect(busy).toHaveLength(2);
  expect(busy[0].error.message).toBe("App login is busy. Try again.");
  expect(results.filter((r) => r.value === null)).toHaveLength(10);
});

test("a login that waits too long for a slot is refused as busy", async () => {
  jest.useFakeTimers();
  try {
    const first = users.authenticate("nick", "wrong password a");
    const second = users.authenticate("nick", "wrong password b");
    const third = users
      .authenticate("nick", "wrong password c")
      .catch((error) => error);
    await jest.advanceTimersByTimeAsync(0);
    expect(running.active).toBe(2);
    await jest.advanceTimersByTimeAsync(2000);
    expect((await third).code).toBe("LOGIN_BUSY");
    running.finish.splice(0).forEach((done) => done());
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    expect(running.active).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});
