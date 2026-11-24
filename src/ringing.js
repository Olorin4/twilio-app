/* Who an inbound call rings. A softphone line rings its enabled assignees who
can still open its workspace, the first 10 by assignment time. A line with
none rings every enabled owner, and so does the legacy number. With no owner
accounts yet, it rings the identity used before user accounts existed.

This runs while Twilio waits for TwiML, so it is one query with a deadline,
and it never throws: any failure rings the bootstrap identity instead, so a
caller never hears silence because of it. */

const pool = require("./db");
const { identityFor } = require("./identity");

const RING_DEADLINE_MS = 1500;
// Twilio's <Dial> takes at most 10 <Client> nouns.
const MAX_RING = 10;

const RING_SQL = `
  WITH assigned AS (
    SELECT u.id, na.created_at AS at
    FROM number_assignees na JOIN app_users u ON u.id = na.user_id
    WHERE na.number_id = $1::uuid AND u.enabled
      AND (u.role = 'owner' OR EXISTS (
        SELECT 1 FROM workspace_members wm
        WHERE wm.workspace_id = $2::uuid AND wm.user_id = u.id))
  ), owners AS (
    SELECT u.id, u.created_at AS at FROM app_users u
    WHERE u.enabled AND u.role = 'owner' AND NOT EXISTS (SELECT 1 FROM assigned)
  )
  SELECT id FROM (
    SELECT id, 0 AS tier, at FROM assigned
    UNION ALL SELECT id, 1 AS tier, at FROM owners
  ) ring
  ORDER BY tier, at, id
  LIMIT ${MAX_RING}`;

// The legacy route has no provider object.
const lineOf = (provider) => provider || { legacy: true };

function bootstrapIdentities(provider) {
  const identity = identityFor({ id: null, bootstrap: true }, lineOf(provider));
  return identity ? [identity] : [];
}

async function ringIdentities(provider) {
  const line = lineOf(provider);
  let timer;
  try {
    const lookup = Promise.resolve(
      pool.query(RING_SQL, [
        line.legacy ? null : line.numberId || null,
        line.workspaceId || null,
      ]),
    );
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("timed out")),
        RING_DEADLINE_MS,
      );
    });
    const { rows } = await Promise.race([lookup, deadline]);
    if (!rows.length) return bootstrapIdentities(provider);
    return rows.map((row) => identityFor({ id: row.id }, line));
  } catch (error) {
    console.error(
      "Ring list unavailable; ringing the bootstrap identity:",
      error.message,
    );
    return bootstrapIdentities(provider);
  } finally {
    clearTimeout(timer);
  }
}

/* Who may place calls and send texts from a line. Owners, and the bootstrap
login until the first owner account exists, may use any line, and the legacy
number. Members may use only lines assigned to them in a workspace they
belong to, and never the legacy number. The account is always read afresh, so a disabled user's still-valid Twilio
token can't place calls, and a role claimed by the caller counts for nothing. */

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACCESS_SQL = `
  SELECT u.role, u.enabled,
    EXISTS (SELECT 1 FROM number_assignees na
      WHERE na.number_id = $2::uuid AND na.user_id = u.id) AS assigned,
    EXISTS (SELECT 1 FROM workspace_members wm
      WHERE wm.workspace_id = $3::uuid AND wm.user_id = u.id) AS member
  FROM app_users u WHERE u.id = $1::uuid`;

// "owner" or "member" when the user may use the line, else null. Throws when
// the account can't be read.
async function lineRole(user, provider) {
  if (!user || !provider) return null;
  // A bootstrap identity (the operator login, or a still-valid Twilio token
  // minted for it) counts as an owner only until the first owner account
  // exists; after cutover it places no calls.
  if (user.bootstrap === true) {
    const { hasEnabledOwner } = require("./users");
    return (await hasEnabledOwner()) ? null : "owner";
  }
  if (typeof user.id !== "string" || !uuidPattern.test(user.id)) return null;
  const numberId = provider.legacy ? null : provider.numberId || null;
  const workspaceId = provider.workspaceId || null;
  const { rows } = await pool.query(ACCESS_SQL, [
    user.id,
    numberId,
    workspaceId,
  ]);
  const account = rows[0];
  if (!account || account.enabled !== true) return null;
  if (account.role === "owner") return "owner";
  if (account.role !== "member" || provider.legacy || !numberId) return null;
  return account.assigned === true && account.member === true ? "member" : null;
}

async function mayUseLine(user, provider) {
  return (await lineRole(user, provider)) !== null;
}

const OWNER_LINES_SQL = `
  SELECT n.id AS number_id, n.phone_number, n.label, c.id AS connection_id
  FROM connection_numbers n JOIN provider_connections c ON c.id = n.connection_id
  LEFT JOIN workspace_active_numbers a ON a.workspace_id = c.workspace_id
  WHERE c.workspace_id = $1::uuid AND n.voice_enabled = true
  ORDER BY (a.connection_number_id = n.id) DESC NULLS LAST, n.phone_number, n.id`;
const MEMBER_LINES_SQL = `
  SELECT n.id AS number_id, n.phone_number, n.label, c.id AS connection_id
  FROM number_assignees na
  JOIN connection_numbers n ON n.id = na.number_id
  JOIN provider_connections c ON c.id = n.connection_id
  WHERE na.user_id = $1::uuid AND c.workspace_id = $2::uuid
    AND ($3::boolean IS FALSE OR n.voice_enabled = true)
    AND EXISTS (SELECT 1 FROM workspace_members wm
      WHERE wm.workspace_id = $2::uuid AND wm.user_id = $1::uuid)
  ORDER BY na.created_at, n.id`;

/* The lines a signed-in user may use in a workspace, as
[{ numberId, phoneNumber, label, legacy, connectionId }]. Owners get every
voice line (the active one first, then the legacy number in Iron Wing);
members only their assigned lines, in assignment order. voiceOnly: false also
returns a member's lines without voice, for texts. */
async function usableLines(user, workspaceId, { voiceOnly = true } = {}) {
  if (!user || !uuidPattern.test(workspaceId || "")) return [];
  const { IRON_WING_WORKSPACE_ID } = require("./workspaceContext");
  const owner = user.role === "owner";
  if (!owner && (user.role !== "member" || !uuidPattern.test(user.id || "")))
    return [];
  const { rows } = owner
    ? await pool.query(OWNER_LINES_SQL, [workspaceId])
    : await pool.query(MEMBER_LINES_SQL, [user.id, workspaceId, voiceOnly]);
  const lines = rows.map((row) => ({
    numberId: row.number_id,
    phoneNumber: row.phone_number,
    label: row.label ?? null,
    legacy: false,
    connectionId: row.connection_id,
  }));
  if (
    owner &&
    workspaceId.toLowerCase() === IRON_WING_WORKSPACE_ID &&
    process.env.TWILIO_CALLER_ID
  )
    lines.push({
      numberId: null,
      phoneNumber: process.env.TWILIO_CALLER_ID,
      label: null,
      legacy: true,
      connectionId: null,
    });
  return lines;
}

module.exports = {
  ringIdentities,
  RING_DEADLINE_MS,
  MAX_RING,
  lineRole,
  mayUseLine,
  usableLines,
};
