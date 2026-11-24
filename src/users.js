/* User accounts: password hashing, the account store and the cached login
check. A User never carries its password hash. */

const crypto = require("crypto");
const { promisify } = require("util");
const pool = require("./db");
const { inTransaction } = require("./workspaceConnections");

const scrypt = promisify(crypto.scrypt);
const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const CACHE_MS = 5 * 60 * 1000;
const MAX_SCRYPT_MEM = 128 * N * R * 2;

const USERNAME_ERROR =
  "Enter a username of 3 to 40 letters, numbers, dots, dashes or underscores.";
const PASSWORD_ERROR = "Enter a password of 12 to 200 characters.";
const LAST_OWNER_ERROR = "Keep at least one enabled owner.";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeUsername(raw) {
  const username = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new Error(USERNAME_ERROR);
  return username;
}

function checkPassword(password) {
  if (
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 200
  )
    throw new Error(PASSWORD_ERROR);
}

function checkRole(role) {
  if (role !== "owner" && role !== "member")
    throw new Error("Choose a role of owner or member.");
}

function checkDisplayName(raw, fallback) {
  const name =
    raw === undefined || raw === null ? fallback : String(raw).trim();
  if (name.length < 1 || name.length > 80)
    throw new Error("Enter a display name of 1 to 80 characters.");
  return name;
}

function checkWorkspaceIds(ids) {
  if (!Array.isArray(ids) || ids.some((id) => !uuidPattern.test(String(id))))
    throw new Error("Choose valid workspaces.");
  return [...new Set(ids.map((id) => String(id).toLowerCase()))];
}

async function hashPassword(plain) {
  checkPassword(plain);
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = await scrypt(plain, salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: MAX_SCRYPT_MEM,
  });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

async function verifyPassword(plain, stored) {
  try {
    const parts = String(stored).split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, n, r, p, salt, hash] = parts;
    const expected = Buffer.from(hash, "base64");
    if (!expected.length) return false;
    const actual = await scrypt(
      String(plain ?? ""),
      Buffer.from(salt, "base64"),
      expected.length,
      { N: Number(n), r: Number(r), p: Number(p), maxmem: MAX_SCRYPT_MEM * 4 },
    );
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const toUser = (row) => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  role: row.role,
  enabled: row.enabled,
  workspaceIds: row.workspace_ids || [],
});

const USER_SELECT = `
  SELECT u.id, u.username, u.display_name, u.role, u.enabled,
         COALESCE(array_agg(m.workspace_id::text ORDER BY m.workspace_id)
                  FILTER (WHERE m.workspace_id IS NOT NULL), '{}') AS workspace_ids
  FROM app_users u
  LEFT JOIN workspace_members m ON m.user_id = u.id`;

// Auth cache: sha256(username:password) -> { user, hash, expires }. `expires`
// is 5 minutes after the last success or passing re-check. The plain
// password is never stored. Every hit is re-checked against the user's row, so
// a password reset, disable or role change made in another process (the admin
// script) is honoured at once. `generation` stops a login that started before
// clearAuthCache from caching its stale snapshot.
const cache = new Map();
let generation = 0;
const cacheKey = (username, password) =>
  crypto.createHash("sha256").update(`${username}:${password}`).digest("hex");
function clearAuthCache() {
  generation += 1;
  cache.clear();
}
const copyUser = (user) => ({ ...user, workspaceIds: [...user.workspaceIds] });

let dummyHash;
async function burnTime(password) {
  dummyHash ||= await hashPassword("not a real password");
  await verifyPassword(password, dummyHash);
}

/* At most MAX_VERIFYING scrypt checks run at once, so failed logins can't
fill libuv's 4-thread pool, which dns.lookup (Twilio and Anthropic calls), fs
and zlib share. A few more wait briefly in line; past that, or after the wait,
the login is refused as busy (503) instead of hanging. */
const MAX_VERIFYING = 2;
const MAX_WAITING = 8;
const WAIT_MS = 2000;
const BUSY_MESSAGE = "App login is busy. Try again.";
let verifying = 0;
const waiting = [];
function busyError() {
  const error = new Error(BUSY_MESSAGE);
  error.code = "LOGIN_BUSY";
  return error;
}
function takeSlot() {
  if (verifying < MAX_VERIFYING) {
    verifying += 1;
    return Promise.resolve();
  }
  if (waiting.length >= MAX_WAITING) return Promise.reject(busyError());
  return new Promise((resolve, reject) => {
    const entry = {
      resolve,
      timer: setTimeout(() => {
        const at = waiting.indexOf(entry);
        if (at >= 0) waiting.splice(at, 1);
        reject(busyError());
      }, WAIT_MS),
    };
    waiting.push(entry);
  });
}
function releaseSlot() {
  const next = waiting.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve(); // the slot passes straight to the next in line
  } else verifying -= 1;
}
async function withVerifySlot(work) {
  await takeSlot();
  try {
    return await work();
  } finally {
    releaseSlot();
  }
}

const lowerId = (id) =>
  uuidPattern.test(String(id)) ? String(id).toLowerCase() : null;

// True when authenticate would look this login up at all: a valid username
// and a password of 1 to 200 characters. Anything else is refused before any
// database read or hashing, so the sign-in limiter does not count it.
function plausibleLogin(username, password) {
  try {
    normalizeUsername(username);
  } catch {
    return false;
  }
  return (
    typeof password === "string" &&
    password.length > 0 &&
    password.length <= 200
  );
}

async function authenticate(username, password) {
  if (!plausibleLogin(username, password)) return null;
  const name = normalizeUsername(username);
  const key = cacheKey(name, password);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) {
    // A failed read throws, so the login answers 503 (still nobody gets in)
    // rather than 401, which would pop the browser's login dialog for every
    // signed-in user on a DB blip.
    const { rows } = await pool.query(
      `${USER_SELECT.replace("SELECT u.id,", "SELECT u.password_hash, u.id,")}
       WHERE u.id = $1 GROUP BY u.id`,
      [hit.user.id],
    );
    const current = rows[0];
    if (
      current &&
      current.enabled &&
      current.password_hash === hit.hash &&
      current.role === hit.user.role
    ) {
      hit.user.workspaceIds = toUser(current).workspaceIds;
      // Only a hit that passed its re-check slides on, so someone working
      // steadily stays signed in without scrypt (or the sign-in limiter).
      hit.expires = Date.now() + CACHE_MS;
      return copyUser(hit.user);
    }
  }
  cache.delete(key);

  const started = generation;
  const { rows } = await pool.query(
    `${USER_SELECT.replace("SELECT u.id,", "SELECT u.password_hash, u.id,")}
     WHERE u.username = $1 GROUP BY u.id`,
    [name],
  );
  const row = rows[0];
  if (!row) {
    await withVerifySlot(() => burnTime(password));
    return null;
  }
  const ok = await withVerifySlot(() =>
    verifyPassword(password, row.password_hash),
  );
  if (!ok || !row.enabled) return null;
  await pool.query("UPDATE app_users SET last_login_at = now() WHERE id = $1", [
    row.id,
  ]);
  const user = toUser(row);
  if (started === generation)
    cache.set(key, {
      user,
      hash: row.password_hash,
      expires: Date.now() + CACHE_MS,
    });
  return copyUser(user);
}

// True when this login is a live cache hit, which needs no scrypt. Lets
// signed-in people through while the failed-login limiter is refusing their
// address (an office shares one). Never true for a login that has not
// succeeded or passed a re-check within the last 5 minutes; authenticate
// still re-checks the row.
function isCachedLogin(username, password) {
  let name;
  try {
    name = normalizeUsername(username);
  } catch {
    return false;
  }
  if (typeof password !== "string" || !password) return false;
  const hit = cache.get(cacheKey(name, password));
  return Boolean(hit && hit.expires > Date.now());
}

async function hasEnabledOwner() {
  const { rows } = await pool.query(
    "SELECT EXISTS (SELECT 1 FROM app_users WHERE role = 'owner' AND enabled) AS exists",
  );
  return rows[0].exists === true;
}

async function listUsers() {
  const { rows } = await pool.query(
    `${USER_SELECT} GROUP BY u.id ORDER BY u.created_at, u.username`,
  );
  return rows.map(toUser);
}

async function getUser(id) {
  if (!uuidPattern.test(String(id))) return null;
  const { rows } = await pool.query(
    `${USER_SELECT} WHERE u.id = $1 GROUP BY u.id`,
    [id],
  );
  return rows[0] ? toUser(rows[0]) : null;
}

async function replaceMemberships(client, userId, workspaceIds) {
  await client.query("DELETE FROM workspace_members WHERE user_id = $1", [
    userId,
  ]);
  for (const workspaceId of workspaceIds)
    await client.query(
      "INSERT INTO workspace_members (workspace_id, user_id) VALUES ($1, $2)",
      [workspaceId, userId],
    );
}

async function createUser({
  username,
  displayName,
  password,
  role,
  workspaceIds = [],
}) {
  const name = normalizeUsername(username);
  checkPassword(password);
  checkRole(role);
  const display = checkDisplayName(displayName, name);
  const workspaces = checkWorkspaceIds(workspaceIds);
  const hash = await hashPassword(password);
  const id = crypto.randomUUID();
  try {
    await inTransaction(async (client) => {
      await client.query(
        `INSERT INTO app_users (id, username, display_name, password_hash, role)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, name, display, hash, role],
      );
      await replaceMemberships(client, id, workspaces);
    });
  } catch (error) {
    if (error.code === "23505") throw new Error("That username is taken.");
    if (error.code === "23503") throw new Error("Choose valid workspaces.");
    throw error;
  }
  clearAuthCache();
  return {
    id,
    username: name,
    displayName: display,
    role,
    enabled: true,
    workspaceIds: workspaces,
  };
}

async function updateUser(id, changes = {}) {
  id = lowerId(id);
  if (!id) throw new Error("User does not exist.");
  if (changes.role !== undefined) checkRole(changes.role);
  if (changes.enabled !== undefined && typeof changes.enabled !== "boolean")
    throw new Error("Enabled must be true or false.");
  const workspaces =
    changes.workspaceIds === undefined
      ? undefined
      : checkWorkspaceIds(changes.workspaceIds);
  let result;
  try {
    result = await inTransaction(async (client) => {
      // Lock every enabled owner so two edits cannot each remove "the other".
      const owners = await client.query(
        "SELECT id FROM app_users WHERE role = 'owner' AND enabled FOR UPDATE",
      );
      const found = await client.query(
        `${USER_SELECT} WHERE u.id = $1 GROUP BY u.id`,
        [id],
      );
      if (!found.rows[0]) throw new Error("User does not exist.");
      const current = toUser(found.rows[0]);
      const next = {
        ...current,
        displayName: checkDisplayName(changes.displayName, current.displayName),
        role: changes.role ?? current.role,
        enabled: changes.enabled ?? current.enabled,
        workspaceIds: workspaces ?? current.workspaceIds,
      };
      const wasEnabledOwner = current.role === "owner" && current.enabled;
      const staysEnabledOwner = next.role === "owner" && next.enabled;
      if (
        wasEnabledOwner &&
        !staysEnabledOwner &&
        !owners.rows.some((row) => row.id !== id)
      )
        throw new Error(LAST_OWNER_ERROR);
      await client.query(
        `UPDATE app_users SET display_name = $2, role = $3, enabled = $4
         WHERE id = $1`,
        [id, next.displayName, next.role, next.enabled],
      );
      if (workspaces) await replaceMemberships(client, id, workspaces);
      return next;
    });
  } catch (error) {
    if (error.code === "23503") throw new Error("Choose valid workspaces.");
    throw error;
  }
  clearAuthCache();
  return result;
}

async function setPassword(id, password) {
  id = lowerId(id);
  if (!id) throw new Error("User does not exist.");
  checkPassword(password);
  const hash = await hashPassword(password);
  const result = await pool.query(
    "UPDATE app_users SET password_hash = $2 WHERE id = $1",
    [id, hash],
  );
  if (!result.rowCount) throw new Error("User does not exist.");
  clearAuthCache();
}

module.exports = {
  hashPassword,
  verifyPassword,
  normalizeUsername,
  authenticate,
  plausibleLogin,
  isCachedLogin,
  hasEnabledOwner,
  MAX_VERIFYING,
  listUsers,
  getUser,
  createUser,
  updateUser,
  setPassword,
  clearAuthCache,
};
