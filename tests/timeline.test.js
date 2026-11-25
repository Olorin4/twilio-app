/* The contact timeline API (src/timeline.js, GET /contacts/:phone/timeline).
The database is mocked: these tests check input handling, the SQL each
source branch carries and the summaries built from rows. The SQL itself runs
on real rows in users.pg.test.js. */
process.env.TWILIO_CALLER_ID = "+12025550000";
process.env.TWILIO_PREVIOUS_NUMBERS = "";
jest.mock("../src/db", () => ({ query: jest.fn() }));
const pool = require("../src/db");
const contacts = require("../src/contacts");
const timeline = require("../src/timeline");
const { lineCondition } = require("../src/visibility");
const { leadCondition } = require("../src/receptionist/store");
const { CALL_LINE, clientLine, sessionCondition } = require("../src/callSql");

const W = "00000000-0000-4000-8000-0000000000e1";
const MEMBER = "00000000-0000-4000-8000-0000000000e4";
const SHARED = "+12025550100";
const CALLER = "+12025550123";
const PHONE_ERROR = "Enter a phone number with its country code.";

const memberScope = {
  all: false,
  hidden: [],
  hiddenClients: [],
  visible: [SHARED],
  numbers: [SHARED],
  clientPrefix: `client:u${MEMBER.replace(/-/g, "")}_`,
};

function handler() {
  const layer = contacts.stack.find(
    (l) =>
      l.route && l.route.path === "/:phone/timeline" && l.route.methods.get,
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
const response = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});
// Answers the scope, contact and timeline queries.
function answer({ rows = [], contact = [] } = {}) {
  pool.query.mockImplementation(async (sql) => {
    if (sql.includes("FROM connection_numbers")) return { rows: [] };
    if (sql.includes("FROM phone_contacts")) return { rows: contact };
    return { rows };
  });
}
const timelineCall = () =>
  pool.query.mock.calls.find(([sql]) => sql.includes("UNION ALL"));
const limitParam = ([sql, params]) =>
  params[Number(/LIMIT \$(\d+)/.exec(sql)[1]) - 1];
const row = (n, kind = "text") => ({
  kind,
  id: String(n),
  at: `2026-11-24T12:00:${String(60 - n).padStart(2, "0")}.000001Z`,
  direction: "inbound",
  line: SHARED,
  body: `message ${n}`,
});

beforeEach(() => pool.query.mockReset());

test("the timeline route is registered before any /:id route", () => {
  const paths = contacts.stack.filter((l) => l.route).map((l) => l.route.path);
  const timelineAt = paths.indexOf("/:phone/timeline");
  expect(timelineAt).toBeGreaterThanOrEqual(0);
  const idRoutes = paths
    .map((path, index) => (path === "/:id" ? index : -1))
    .filter((index) => index >= 0);
  expect(idRoutes.every((index) => index > timelineAt)).toBe(true);
});

test.each(["anonymous", "client:u1_c2", "+1 555 0100", "5550100", ""])(
  "rejects anything that is not a phone number (%p)",
  async (phone) => {
    const res = response();
    await handler()(
      {
        user: { id: MEMBER, role: "member" },
        workspace: { id: W },
        params: { phone },
        query: {},
      },
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: PHONE_ERROR });
    expect(pool.query).not.toHaveBeenCalled();
  },
);

describe("each kind's summary text", () => {
  const long = "word ".repeat(60).trim();
  test.each([
    [
      "missed call",
      { kind: "call", direction: "inbound", missed: true, duration: 0 },
      "Missed call",
    ],
    [
      "missed by an inbound status",
      { kind: "call", direction: "inbound", status: "no-answer" },
      "Missed call",
    ],
    [
      "missed by its announcement",
      {
        kind: "call",
        direction: "inbound",
        answered: true,
        announcement: "missed",
        duration: 30,
      },
      "Missed call",
    ],
    [
      "answered, rounded up to whole minutes",
      {
        kind: "call",
        direction: "inbound",
        answered: true,
        status: "completed",
        duration: 125,
      },
      "Answered · 3 min",
    ],
    [
      "after hours (closed announcement), not answered",
      {
        kind: "call",
        direction: "inbound",
        answered: false,
        announcement: "closed",
        status: "completed",
        duration: 40,
      },
      "Incoming call · 1 min",
    ],
    [
      "failed, not answered",
      {
        kind: "call",
        direction: "inbound",
        answered: false,
        status: "failed",
        duration: 0,
      },
      "Incoming call",
    ],
    [
      "still ringing",
      {
        kind: "call",
        direction: "inbound",
        answered: false,
        status: "ringing",
        duration: null,
      },
      "Incoming call",
    ],
    [
      "completed but never bridged to anyone",
      {
        kind: "call",
        direction: "inbound",
        answered: false,
        status: "completed",
        duration: 125,
      },
      "Incoming call · 3 min",
    ],
    [
      "outgoing with no duration",
      { kind: "call", direction: "outbound", duration: 0 },
      "Outgoing call",
    ],
    [
      "outgoing with a duration",
      { kind: "call", direction: "outbound", duration: 60 },
      "Outgoing call · 1 min",
    ],
    [
      "a text collapsed to one line",
      { kind: "text", body: "  Load is\n\nready   at dock 4 " },
      "Load is ready at dock 4",
    ],
    [
      "a text of exactly 140 characters",
      { kind: "text", body: "x".repeat(140) },
      "x".repeat(140),
    ],
    [
      "a long text cut to 140 characters",
      { kind: "text", body: long },
      `${long.slice(0, 139)}…`,
    ],
    ["an empty text", { kind: "text", body: null }, "Text message"],
    [
      "an agent lead, first line of its summary",
      {
        kind: "agent_call",
        outcome: "lead",
        summary: "  Needs a truck Friday.\nMore detail.",
      },
      "New lead: Needs a truck Friday.",
    ],
    [
      "an agent call with no summary",
      { kind: "agent_call", outcome: "abandoned", summary: null },
      "Hung up",
    ],
    [
      "a Live Assist summary",
      {
        kind: "assist",
        assist: true,
        assist_summary: { reason: "Rate check\nfor lane", outcome: "x" },
        notes: "note",
      },
      "Rate check",
    ],
    [
      "Live Assist notes when there is no summary",
      {
        kind: "assist",
        assist: true,
        assist_summary: null,
        notes: "\n Call back Monday\nok",
      },
      "Call back Monday",
    ],
    [
      "Live Assist with neither",
      {
        kind: "assist",
        assist: true,
        assist_summary: { reason: " " },
        notes: "",
      },
      "Live Assist call",
    ],
    [
      "a plain call session, first line of its notes",
      {
        kind: "assist",
        assist: false,
        assist_summary: null,
        notes: "Quoted 2.10/mi\nwill call back",
      },
      "Quoted 2.10/mi",
    ],
    [
      "a plain call session with only an outcome",
      { kind: "assist", assist: false, assist_summary: null, notes: "" },
      "Call notes",
    ],
  ])("%s", (_, fields, summary) => {
    expect(timeline.summarize(fields)).toBe(summary);
  });

  test.each([
    ["lead", "New lead"],
    ["not_a_lead", "Message"],
    ["message", "Message"],
    ["urgent", "Urgent"],
    ["support_request", "Support request"],
    ["not_support", "Not support"],
    ["prospect", "Sales prospect"],
    ["spam", "Spam"],
    ["abandoned", "Hung up"],
    ["failed", "Agent failed"],
  ])("outcome %s is labelled %s", (outcome, label) => {
    expect(
      timeline.summarize({ kind: "agent_call", outcome, summary: "Hi" }),
    ).toBe(`${label}: Hi`);
  });
});

test("every source query carries the visibility condition", async () => {
  answer();
  await timeline.contactTimeline({
    scope: memberScope,
    workspaceId: W,
    phone: CALLER,
  });
  const [sql, params] = timelineCall();
  // Four branches, each with its own condition on its own params.
  expect(sql.match(/UNION ALL/g)).toHaveLength(3);
  const [calls, texts, agents, assists] =
    timeline.branchConditions(memberScope);
  const expected = [
    [
      calls,
      (n) =>
        lineCondition(
          memberScope,
          CALL_LINE,
          "cl.from_number",
          n,
          clientLine("cl"),
        ),
    ],
    [
      texts,
      (n) => lineCondition(memberScope, timeline.TEXT_LINE, "m.from_number", n),
    ],
    [agents, (n) => leadCondition(memberScope, n)],
    [assists, (n) => sessionCondition(memberScope, n)],
  ];
  let next = timeline.FIXED_PARAMS + 1;
  for (const [condition, build] of expected) {
    const built = build(next);
    expect(condition).toEqual(built);
    expect(sql).toContain(built.sql);
    expect(params.slice(next - 1, next - 1 + built.params.length)).toEqual(
      built.params,
    );
    next += built.params.length;
  }
  expect(params).toHaveLength(next - 1);
  // Every placeholder has a value, the phone is a parameter, and the
  // member's lines are what is passed - nothing is interpolated.
  const used = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  expect(Math.max(...used)).toBe(params.length);
  expect(sql).not.toContain(CALLER);
  expect(params).toContain(CALLER);
  expect(params).toContainEqual([SHARED]);
  // A plain call session shows only once it has notes or an outcome.
  expect(sql).toContain(
    "AND (s.assist OR COALESCE(s.notes, '') <> '' OR s.outcome IS NOT NULL)",
  );
  // The leads condition carries its third, owners-only param.
  expect(agents.params).toEqual([memberScope.clientPrefix, [SHARED], false]);
});

test("limit defaults to 20 and is capped at 50", async () => {
  answer();
  await timeline.contactTimeline({
    scope: memberScope,
    workspaceId: W,
    phone: CALLER,
  });
  expect(limitParam(timelineCall())).toBe(21);
  pool.query.mockClear();
  await timeline.contactTimeline({
    scope: memberScope,
    workspaceId: W,
    phone: CALLER,
    limit: "500",
  });
  expect(limitParam(timelineCall())).toBe(51);
  pool.query.mockClear();
  await timeline.contactTimeline({
    scope: memberScope,
    workspaceId: W,
    phone: CALLER,
    limit: "5",
  });
  expect(limitParam(timelineCall())).toBe(6);
});

test.each(["0", "-1", "abc", "2.5"])("limit %p is a 400", async (limit) => {
  const res = response();
  await handler()(
    {
      user: { id: MEMBER, role: "member" },
      workspace: { id: W },
      params: { phone: CALLER },
      query: { limit },
    },
    res,
  );
  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith({ error: "Invalid limit." });
  expect(pool.query).not.toHaveBeenCalled();
});

const b64 = (value) => Buffer.from(value).toString("base64url");
test.each([
  ["not base64 json", "!!!"],
  ["not json", b64("nope")],
  ["an array", b64("[1]")],
  [
    "an unknown kind",
    b64(
      JSON.stringify({
        at: "2026-11-24T12:00:00.000001Z",
        kind: "fax",
        id: "1",
      }),
    ),
  ],
  [
    "a bad time",
    b64(JSON.stringify({ at: "yesterday", kind: "call", id: "1" })),
  ],
  [
    "an impossible time",
    b64(JSON.stringify({ at: "2026-13-45T12:00:00Z", kind: "call", id: "1" })),
  ],
  ["no id", b64(JSON.stringify({ at: "2026-11-24T12:00:00Z", kind: "call" }))],
  [
    "a numeric id",
    b64(JSON.stringify({ at: "2026-11-24T12:00:00Z", kind: "call", id: 1 })),
  ],
])("a bad cursor is a 400 (%s)", async (_, cursor) => {
  const res = response();
  await handler()(
    {
      user: { id: MEMBER, role: "member" },
      workspace: { id: W },
      params: { phone: CALLER },
      query: { cursor },
    },
    res,
  );
  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith({ error: "Invalid cursor." });
  expect(pool.query).not.toHaveBeenCalled();
});

test("a cursor is passed as parameters and round-trips", async () => {
  answer({ rows: [row(1), row(2), row(3)] });
  const first = await timeline.contactTimeline({
    scope: memberScope,
    workspaceId: W,
    phone: CALLER,
    limit: 2,
  });
  expect(first.entries.map((e) => e.id)).toEqual(["1", "2"]);
  expect(JSON.parse(Buffer.from(first.next, "base64url").toString())).toEqual({
    at: row(2).at,
    kind: "text",
    id: "2",
  });
  pool.query.mockClear();
  answer({ rows: [row(3)] });
  await timeline.contactTimeline({
    scope: memberScope,
    workspaceId: W,
    phone: CALLER,
    limit: 2,
    cursor: first.next,
  });
  const [sql, params] = timelineCall();
  expect(params.slice(0, timeline.FIXED_PARAMS)).toEqual(
    expect.arrayContaining([row(2).at, "text", "2"]),
  );
  expect(sql).not.toContain(row(2).at);
});

test("next is null on the last page", async () => {
  answer({ rows: [row(1), row(2)] });
  const result = await timeline.contactTimeline({
    scope: memberScope,
    workspaceId: W,
    phone: CALLER,
    limit: 2,
  });
  expect(result.entries).toHaveLength(2);
  expect(result.next).toBeNull();
});

test("the route answers entries, the contact and next", async () => {
  answer({
    rows: [
      {
        kind: "agent_call",
        id: "CA9",
        at: "2026-11-24T12:00:00.000000Z",
        direction: "inbound",
        line: SHARED,
        outcome: "lead",
        summary: "Wants a quote",
        call_sid: "CA9",
      },
      {
        kind: "assist",
        id: "00000000-0000-4000-8000-0000000000aa",
        at: "2026-11-24T11:00:00.000000Z",
        direction: "outbound",
        line: SHARED,
        assist_summary: null,
        notes: "",
        call_sid: null,
        assist: true,
      },
      {
        kind: "assist",
        id: "00000000-0000-4000-8000-0000000000ab",
        at: "2026-11-24T10:00:00.000000Z",
        direction: "outbound",
        line: SHARED,
        assist_summary: null,
        notes: "Left a voicemail",
        call_sid: "CA8",
        assist: false,
      },
      {
        kind: "assist",
        id: "00000000-0000-4000-8000-0000000000ac",
        at: "2026-11-24T09:00:00.000000Z",
        direction: "outbound",
        line: SHARED,
        assist_summary: { reason: "Rate check" },
        notes: "",
        call_sid: "CA7",
        assist: true,
      },
    ],
    contact: [{ name: "Alex", company: "Carrier" }],
  });
  const res = response();
  await handler()(
    {
      user: { id: MEMBER, role: "member" },
      workspace: { id: W },
      params: { phone: CALLER },
      query: {},
    },
    res,
  );
  expect(res.status).not.toHaveBeenCalled();
  expect(res.json).toHaveBeenCalledWith({
    contact: { name: "Alex", company: "Carrier" },
    entries: [
      {
        kind: "agent_call",
        id: "CA9",
        at: "2026-11-24T12:00:00.000000Z",
        direction: "inbound",
        line: SHARED,
        summary: "New lead: Wants a quote",
        link: { view: "leads", callSid: "CA9" },
      },
      {
        kind: "assist",
        id: "00000000-0000-4000-8000-0000000000aa",
        at: "2026-11-24T11:00:00.000000Z",
        direction: "outbound",
        line: SHARED,
        summary: "Live Assist call",
        link: null,
      },
      {
        kind: "assist",
        id: "00000000-0000-4000-8000-0000000000ab",
        at: "2026-11-24T10:00:00.000000Z",
        direction: "outbound",
        line: SHARED,
        summary: "Left a voicemail",
        link: null,
      },
      {
        kind: "assist",
        id: "00000000-0000-4000-8000-0000000000ac",
        at: "2026-11-24T09:00:00.000000Z",
        direction: "outbound",
        line: SHARED,
        summary: "Rate check",
        link: { view: "call", callSid: "CA7" },
      },
    ],
    next: null,
  });
});

test("a database failure is a 500 without details", async () => {
  pool.query.mockRejectedValue(new Error("boom secret"));
  const res = response();
  jest.spyOn(console, "error").mockImplementation(() => {});
  await handler()(
    {
      user: { id: MEMBER, role: "member" },
      workspace: { id: W },
      params: { phone: CALLER },
      query: {},
    },
    res,
  );
  expect(res.status).toHaveBeenCalledWith(500);
  expect(res.json).toHaveBeenCalledWith({
    error: "Could not load the timeline.",
  });
  console.error.mockRestore();
});
