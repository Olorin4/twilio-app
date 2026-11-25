/* One caller's history in one workspace, newest first: calls, texts, AI
agent calls and app-dialed call sessions with that phone number (a Live
Assist session, or a plain one only once it has notes or an outcome; a plain
session is otherwise just its call). Every source is
filtered by the viewer's line scope (src/visibility.js) in SQL, so a row the
viewer may not see is never fetched, counted or summarised.

Paging is by an opaque cursor, the base64url JSON { at, kind, id } of the
last entry shown, ordered at DESC, kind ASC, id DESC. at keeps the database's
microseconds so entries at the same instant neither repeat nor go missing. */
const pool = require("./db");
const { lineCondition } = require("./visibility");
const { leadCondition } = require("./receptionist/store");
const {
  clientLine,
  CALL_LINE,
  CALL_STATUS,
  CALL_MISSED,
  CALL_ANSWERED,
  CALL_ANNOUNCEMENT,
  CALL_DURATION,
  CALL_OUTGOING,
  CALL_LOCAL_NUMBER,
  CALL_ROOT,
  sessionCondition,
} = require("./callSql");

const PHONE = /^\+[1-9]\d{7,14}$/;
const KINDS = ["agent_call", "assist", "call", "text"];
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const SUMMARY_LENGTH = 140;

const PHONE_ERROR = "Enter a phone number with its country code.";
const CURSOR_ERROR = "Invalid cursor.";
const LIMIT_ERROR = "Invalid limit.";

class TimelineInputError extends Error {}

/* $1 the legacy caller ID (the call expressions in callSql.js use it), $2
the workspace, $3 the phone, $4 the viewer's line numbers (a text's line),
$5 the row limit, $6-$8 the cursor's at, kind and id (null on page one).
The visibility conditions follow, numbered from FIXED_PARAMS + 1. */
const FIXED_PARAMS = 8;

// A text's line: from_number when one of the lines sent it, as in history.
const TEXT_LINE =
  "CASE WHEN m.from_number = ANY($4::text[]) THEN m.from_number ELSE m.to_number END";

const OUTCOME_LABELS = {
  lead: "New lead",
  not_a_lead: "Message",
  message: "Message",
  urgent: "Urgent",
  support_request: "Support request",
  prospect: "Sales prospect",
  not_support: "Not support",
  spam: "Spam",
  abandoned: "Hung up",
  failed: "Agent failed",
};

const validPhone = (phone) => typeof phone === "string" && PHONE.test(phone);

function parseLimit(value) {
  if (value === undefined || value === null || value === "")
    return DEFAULT_LIMIT;
  const limit =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d{1,6}$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isInteger(limit) || limit < 1)
    throw new TimelineInputError(LIMIT_ERROR);
  return Math.min(limit, MAX_LIMIT);
}

const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const ID = /^[A-Za-z0-9-]{1,64}$/;

function encodeCursor({ at, kind, id }) {
  return Buffer.from(JSON.stringify({ at, kind, id })).toString("base64url");
}

// { at, kind, id }, or null when there is no cursor. Throws on a bad one.
function parseCursor(value) {
  if (value === undefined || value === null || value === "") return null;
  const bad = () => new TimelineInputError(CURSOR_ERROR);
  if (typeof value !== "string" || value.length > 512) throw bad();
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw bad();
  let cursor;
  try {
    cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor))
    throw bad();
  const { at, kind, id } = cursor;
  if (typeof at !== "string" || !AT.test(at)) throw bad();
  const date = new Date(at);
  // Rejects dates that do not exist, such as February 30th.
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 19) !== at.slice(0, 19)
  )
    throw bad();
  if (!KINDS.includes(kind)) throw bad();
  if (typeof id !== "string" || !ID.test(id)) throw bad();
  return { at, kind, id };
}

// Checks every input before anything is read. Throws TimelineInputError.
function parseInput({ phone, cursor, limit }) {
  if (!validPhone(phone)) throw new TimelineInputError(PHONE_ERROR);
  return { phone, cursor: parseCursor(cursor), limit: parseLimit(limit) };
}

/* Each source's visibility condition, in branch order (calls, texts, agent
calls, Live Assist), numbered one after another from FIXED_PARAMS + 1. */
function branchConditions(scope) {
  const builders = [
    (n) =>
      lineCondition(scope, CALL_LINE, "cl.from_number", n, clientLine("cl")),
    (n) => lineCondition(scope, TEXT_LINE, "m.from_number", n),
    (n) => leadCondition(scope, n),
    (n) => sessionCondition(scope, n),
  ];
  let next = FIXED_PARAMS + 1;
  return builders.map((build) => {
    const condition = build(next);
    next += condition.params.length;
    return condition;
  });
}

// Every branch has the same columns; at is a timestamptz.
const columns = ({
  status = "NULL::text",
  missed = "NULL::boolean",
  answered = "NULL::boolean",
  announcement = "NULL::text",
  duration = "NULL::integer",
  body = "NULL::text",
  outcome = "NULL::text",
  summary = "NULL::text",
  assistSummary = "NULL::jsonb",
  notes = "NULL::text",
  callSid = "NULL::text",
  assist = "NULL::boolean",
}) => `${status} AS status, ${missed} AS missed, ${answered} AS answered,
    ${announcement} AS announcement, ${duration} AS duration, ${body} AS body,
    ${outcome} AS outcome, ${summary} AS summary,
    ${assistSummary} AS assist_summary, ${notes} AS notes,
    ${callSid} AS call_sid, ${assist} AS assist`;

function timelineQuery(conditions) {
  const [calls, texts, agents, assists] = conditions;
  const outbound = `(${CALL_OUTGOING} OR cl.direction LIKE 'outbound%')`;
  return `SELECT t.kind, t.id,
      to_char(t.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
      t.direction, t.line, t.status, t.missed, t.answered, t.announcement,
      t.duration, t.body, t.outcome, t.summary, t.assist_summary, t.notes,
      t.call_sid, t.assist
    FROM (
      SELECT 'call'::text AS kind, cl.id::text AS id,
        cl.timestamp AT TIME ZONE 'UTC' AS at,
        CASE WHEN ${outbound} THEN 'outbound' ELSE 'inbound' END AS direction,
        ${CALL_LOCAL_NUMBER} AS line,
        ${columns({
          status: CALL_STATUS,
          missed: CALL_MISSED,
          answered: CALL_ANSWERED,
          announcement: `(${CALL_ANNOUNCEMENT})->>'kind'`,
          duration: CALL_DURATION,
        })}
      FROM call_logs cl
      WHERE cl.workspace_id = $2 AND cl.timestamp IS NOT NULL
        AND (cl.from_number = $3 OR cl.to_number = $3)
        AND (CASE WHEN ${outbound} THEN cl.to_number = $3 ELSE cl.from_number = $3 END)
        AND ${CALL_ROOT}
        AND ${calls.sql}
      UNION ALL
      SELECT 'text'::text, m.id::text, m.timestamp AT TIME ZONE 'UTC',
        CASE WHEN m.from_number = ANY($4::text[]) THEN 'outbound' ELSE 'inbound' END,
        ${TEXT_LINE},
        ${columns({ body: "m.body" })}
      FROM message_logs m
      WHERE m.workspace_id = $2 AND m.timestamp IS NOT NULL
        AND (m.from_number = $3 OR m.to_number = $3)
        AND ${texts.sql}
      UNION ALL
      SELECT 'agent_call'::text, c.call_sid, c.started_at, 'inbound',
        (SELECT lc.to_number FROM call_logs lc WHERE lc.call_sid = c.call_sid
           AND lc.workspace_id = c.workspace_id ORDER BY lc.id LIMIT 1),
        ${columns({
          outcome: "COALESCE(c.outcome, 'failed')",
          summary: "c.summary",
          callSid: "c.call_sid",
        })}
      FROM receptionist_calls c
      WHERE c.workspace_id = $2
        AND (c.from_number = $3 OR c.callback_number = $3)
        AND (c.ended_at IS NOT NULL OR c.started_at < now() - interval '15 minutes')
        AND ${agents.sql}
      UNION ALL
      SELECT 'assist'::text, s.id::text, s.created_at, 'outbound', s.from_number,
        ${columns({
          assistSummary: "s.summary",
          notes: "s.notes",
          callSid: "s.call_sid",
          assist: "s.assist",
        })}
      FROM phone_call_sessions s
      WHERE s.workspace_id = $2 AND s.destination = $3
        AND (s.assist OR COALESCE(s.notes, '') <> '' OR s.outcome IS NOT NULL)
        AND ${assists.sql}
    ) t
    WHERE $6::timestamptz IS NULL OR t.at < $6::timestamptz
      OR (t.at = $6::timestamptz AND (t.kind > $7::text
        OR (t.kind = $7::text AND t.id < $8::text)))
    ORDER BY t.at DESC, t.kind ASC, t.id DESC
    LIMIT $5`;
}

// The text up to its first newline, trimmed.
const firstLine = (value) =>
  typeof value === "string" ? value.trim().split("\n")[0].trim() : "";

// Cut to SUMMARY_LENGTH characters, the last one an ellipsis.
function cut(text) {
  const chars = Array.from(text);
  return chars.length > SUMMARY_LENGTH
    ? `${chars.slice(0, SUMMARY_LENGTH - 1).join("")}…`
    : text;
}

const minutes = (seconds) => {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? Math.ceil(value / 60) : 0;
};

// Missed as call history shows it (isMissedCall in frontend/src/main.jsx).
const missedCall = (row) =>
  row.announcement === "missed" ||
  row.missed === true ||
  (row.direction === "inbound" &&
    ["no-answer", "busy", "canceled"].includes(row.status));

// The one-line summary of a row, built from its fields.
function summarize(row) {
  switch (row.kind) {
    case "call": {
      if (row.direction === "inbound" && missedCall(row)) return "Missed call";
      const length = minutes(row.duration);
      if (row.direction === "outbound")
        return length ? `Outgoing call · ${length} min` : "Outgoing call";
      if (row.answered === true) return `Answered · ${length} min`;
      // After hours, failed, still ringing or never bridged.
      return length ? `Incoming call · ${length} min` : "Incoming call";
    }
    case "text":
      return (
        cut(
          String(row.body || "")
            .replace(/\s+/g, " ")
            .trim(),
        ) || "Text message"
      );
    case "agent_call": {
      const label = OUTCOME_LABELS[row.outcome] || OUTCOME_LABELS.failed;
      const line = cut(firstLine(row.summary));
      return line ? `${label}: ${line}` : label;
    }
    case "assist": {
      const summary = row.assist_summary || {};
      return (
        cut(
          firstLine(summary.reason) ||
            firstLine(summary.outcome) ||
            firstLine(row.notes),
        ) || (row.assist ? "Live Assist call" : "Call notes")
      );
    }
    default:
      return "";
  }
}

function linkFor(row) {
  if (row.kind === "agent_call" && row.call_sid)
    return { view: "leads", callSid: row.call_sid };
  if (row.kind === "assist" && row.assist === true && row.call_sid)
    return { view: "call", callSid: row.call_sid };
  return null;
}

const entryFor = (row) => ({
  kind: row.kind,
  id: row.id,
  at: row.at,
  direction: row.direction ?? null,
  line: row.line ?? null,
  summary: summarize(row),
  link: linkFor(row),
});

/* { contact, entries, next } for one phone in one workspace, as the viewer
with this scope (from lineScope) may see it. cursor is the opaque string
from a previous page's next; limit defaults to 20, at most 50. Bad input
throws a TimelineInputError before any query. */
async function contactTimeline({ scope, workspaceId, phone, cursor, limit }) {
  const input = parseInput({ phone, cursor, limit });
  const conditions = branchConditions(scope);
  const params = [
    process.env.TWILIO_CALLER_ID || null,
    workspaceId,
    input.phone,
    scope?.numbers ?? [],
    input.limit + 1,
    input.cursor?.at ?? null,
    input.cursor?.kind ?? null,
    input.cursor?.id ?? null,
    ...conditions.flatMap((condition) => condition.params),
  ];
  const [contactResult, timelineResult] = await Promise.all([
    pool.query(
      `SELECT name, company FROM phone_contacts
       WHERE workspace_id = $1 AND phone = $2 ORDER BY lower(name) LIMIT 1`,
      [workspaceId, input.phone],
    ),
    pool.query(timelineQuery(conditions), params),
  ]);
  const rows = timelineResult.rows;
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  const [contact] = contactResult.rows;
  return {
    contact: contact
      ? { name: contact.name, company: contact.company ?? "" }
      : null,
    entries: page.map(entryFor),
    next: rows.length > input.limit && last ? encodeCursor(last) : null,
  };
}

module.exports = {
  contactTimeline,
  parseInput,
  summarize,
  branchConditions,
  encodeCursor,
  parseCursor,
  parseLimit,
  TimelineInputError,
  FIXED_PARAMS,
  TEXT_LINE,
  PHONE_ERROR,
};
