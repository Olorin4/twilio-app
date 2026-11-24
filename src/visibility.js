/* Which lines' history a person may see in a workspace. A call or message
belongs to a line by its number: to_number when inbound, from_number when
outbound. A user sees a line when they are assigned to it, when it isn't
personal and they are an owner, or when it isn't personal, an AI agent answers
it and they are a member of its workspace. The legacy Iron Wing numbers count
as a shared AI line. A personal line nobody enabled can answer rings the
owners, so owners see it too.

Owners are filtered by what they may not see (so history on a released number
stays visible to them); members by what they may see (so it does not).
Outbound softphone calls (from client:<identity>) carry no line number: a
member sees only their own, an owner every one except another user's calls on
a connection where all of that user's lines are personal lines hidden from the
owner. The scope is read once per request, in one query, and follows the
lines' current settings. */

const pool = require("./db");
const { identityFor } = require("./identity");

const SCOPE_SQL = `
  SELECT n.phone_number, n.personal, n.handler, c.id AS connection_id,
    COALESCE(array_agg(na.user_id::text) FILTER (WHERE na.user_id IS NOT NULL),
      '{}') AS assignees,
    COALESCE(bool_or(u.enabled AND (u.role = 'owner' OR EXISTS (
      SELECT 1 FROM workspace_members wm
      WHERE wm.workspace_id = c.workspace_id AND wm.user_id = u.id))), false)
      AS staffed
  FROM connection_numbers n
  JOIN provider_connections c ON c.id = n.connection_id
  LEFT JOIN number_assignees na ON na.number_id = n.id
  LEFT JOIN app_users u ON u.id = na.user_id
  WHERE c.workspace_id = $1::uuid
  GROUP BY n.id, n.phone_number, n.personal, n.handler, c.id`;

const same = (a, b) =>
  String(a || "").toLowerCase() === String(b || "").toLowerCase();
const nothing = () => ({
  all: false,
  hidden: [],
  hiddenClients: [],
  visible: [],
  numbers: [],
  clientPrefix: null,
});

// Required lazily: conversations.js requires modules that require this one.
const legacyNumbers = (workspaceId) => {
  const { IRON_WING_WORKSPACE_ID } = require("./workspaceContext");
  return same(workspaceId, IRON_WING_WORKSPACE_ID)
    ? require("./conversations").numbers()
    : [];
};

/* { all, hidden, hiddenClients, visible, numbers, clientPrefix }. all: true
for owners, who are filtered by hidden (line numbers) and hiddenClients
(client: callers); members are filtered by visible. numbers are the lines a
row's direction is judged against: every line for owners, the visible ones
for members. clientPrefix starts the user's own softphone callers, or is
null for the bootstrap login. */
async function lineScope(user, workspaceId) {
  const owner = user?.role === "owner";
  if (!user || (!owner && (user.role !== "member" || !user.id)))
    return nothing();
  const { rows } = await pool.query(SCOPE_SQL, [workspaceId]);
  const userId = user.bootstrap === true ? null : user.id || null;
  const mine = (row) => row.assignees.some((id) => same(id, userId));
  const legacy = legacyNumbers(workspaceId);
  // Every identity of this user starts u<id>_ (see identity.js).
  const prefix = userId
    ? `client:u${String(userId).replace(/-/g, "").toLowerCase()}_`
    : null;
  if (!owner) {
    const visible = rows
      .filter(
        (row) => mine(row) || (!row.personal && row.handler === "ai_agent"),
      )
      .map((row) => row.phone_number);
    const lines = [...new Set([...visible, ...legacy])];
    return {
      all: false,
      hidden: [],
      hiddenClients: [],
      visible: lines,
      numbers: lines,
      clientPrefix: prefix,
    };
  }
  const hiddenRow = (row) => row.personal && row.staffed && !mine(row);
  const shown = new Set(
    rows.filter((row) => !hiddenRow(row)).map((r) => r.phone_number),
  );
  const hidden = [
    ...new Set(
      rows
        .filter((row) => hiddenRow(row) && !shown.has(row.phone_number))
        .map((row) => row.phone_number),
    ),
  ];
  // Another user's softphone calls on a connection where every line of
  // theirs is hidden from this owner.
  const byIdentity = new Map();
  for (const row of rows)
    for (const assignee of row.assignees) {
      if (same(assignee, userId)) continue;
      const identity = `client:${identityFor({ id: assignee }, { id: row.connection_id })}`;
      const all = byIdentity.get(identity) ?? true;
      byIdentity.set(identity, all && hidden.includes(row.phone_number));
    }
  const hiddenClients = [...byIdentity]
    .filter(([, allHidden]) => allHidden)
    .map(([identity]) => identity);
  return {
    all: true,
    hidden,
    hiddenClients,
    visible: [],
    numbers: [...new Set([...rows.map((row) => row.phone_number), ...legacy])],
    clientPrefix: prefix,
  };
}

// True when the scope shows a line's history.
function canSee(scope, number) {
  if (!scope || typeof number !== "string") return false;
  return scope.all
    ? !scope.hidden.includes(number)
    : scope.visible.includes(number);
}

/* A SQL condition on one call or message row. lineExpr picks the row's line
(to_number or from_number by direction), fromExpr is its raw from_number;
params are numbered from firstParam. */
function lineCondition(scope, lineExpr, fromExpr, firstParam) {
  const a = `$${firstParam}`;
  const b = `$${firstParam + 1}`;
  const from = `COALESCE(${fromExpr}, '')`;
  const line = `COALESCE(${lineExpr}, '')`;
  if (scope?.all)
    return {
      sql: `(CASE WHEN ${from} LIKE 'client:%' THEN NOT (${from} = ANY(${a}::text[]))
        ELSE NOT (${line} = ANY(${b}::text[])) END)`,
      params: [scope.hiddenClients, scope.hidden],
    };
  return {
    sql: `(CASE WHEN ${from} LIKE 'client:%'
        THEN ${a}::text IS NOT NULL AND left(${from}, length(${a}::text)) = ${a}::text
        ELSE ${line} = ANY(${b}::text[]) END)`,
    params: [scope?.clientPrefix ?? null, scope?.visible ?? []],
  };
}

module.exports = { lineScope, lineCondition, canSee, SCOPE_SQL };
