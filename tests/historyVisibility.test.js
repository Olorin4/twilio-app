/* A member (a dispatcher in Iron Wing) sees nothing of the owner's personal
line through any history endpoint (Review Focus 4). The database is mocked:
each test checks that the endpoint's SQL carries the visibility filter and
that nothing it sends names the personal line, or that a hidden item answers
exactly like a missing one. The SQL itself runs in users.pg.test.js. */
process.env.TWILIO_CALLER_ID = "+12025550000";
process.env.TWILIO_PREVIOUS_NUMBERS = "";
jest.mock("twilio", () => jest.fn(() => ({ calls: {}, messages: {} })));
jest.mock("../src/token", () => ({
  accountSid: "ACtest",
  authToken: "test",
  getIdentity: () => "operator",
}));
jest.mock("../src/db", () => ({ query: jest.fn() }));
jest.mock("../src/messageEvents", () => ({ publish: jest.fn() }));
const pool = require("../src/db");
const { publish } = require("../src/messageEvents");
const { getCallLogs, getMessageLogs } = require("../src/logManager");
const conversations = require("../src/conversations");
const activityViews = require("../src/activityViews");
const callAssist = require("../src/callAssist/routes");

const IRON_WING = "00000000-0000-4000-8000-000000000001";
const CONN = "00000000-0000-4000-8000-0000000000c1";
const OWNER = "00000000-0000-4000-8000-0000000000b1";
const MEMBER = "00000000-0000-4000-8000-0000000000b2";
const SESSION = "00000000-0000-4000-8000-0000000000d1";
const CALL_SID = "CA" + "1".repeat(32);
const SHARED = "+12025550100";
const PERSONAL = "+12025550199";
const member = { id: MEMBER, role: "member", workspaceIds: [IRON_WING] };
const scopeRows = [
  {
    phone_number: SHARED,
    personal: false,
    handler: "softphone",
    connection_id: CONN,
    assignees: [MEMBER],
    staffed: true,
  },
  {
    phone_number: PERSONAL,
    personal: true,
    handler: "softphone",
    connection_id: CONN,
    assignees: [OWNER],
    staffed: true,
  },
];

const isScope = (sql) =>
  sql.includes("FROM connection_numbers n") && sql.includes("number_assignees");
beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockImplementation(async (sql) =>
    isScope(sql) ? { rows: scopeRows } : { rows: [], rowCount: 0 },
  );
});
// The endpoint's own queries, after the one scope lookup.
const endpointCalls = () =>
  pool.query.mock.calls.filter(([sql]) => !isScope(sql));
const scopeLookups = () =>
  pool.query.mock.calls.filter(([sql]) => isScope(sql)).length;
const expectFiltered = () => {
  expect(scopeLookups()).toBe(1);
  const calls = endpointCalls();
  expect(calls.length).toBeGreaterThan(0);
  for (const [, params] of calls)
    expect(JSON.stringify(params)).not.toContain(PERSONAL);
  const [sql, params] = calls[0];
  expect(sql).toMatch(/= ANY\(\$\d+::text\[\]\)/);
  expect(params).toContainEqual(`client:u${MEMBER.replace(/-/g, "")}_`);
  return calls;
};
const response = () => ({
  set: jest.fn(),
  json: jest.fn(),
  status: jest.fn().mockReturnThis(),
  sendStatus: jest.fn(),
});
const request = (extra) => ({
  user: member,
  workspace: { id: IRON_WING },
  query: {},
  params: {},
  body: {},
  ...extra,
});

test("call history is filtered to the member's lines", async () => {
  const res = response();
  await getCallLogs(request(), res);
  expectFiltered();
  expect(res.json).toHaveBeenCalledWith([]);
});

test("call history search is filtered to the member's lines", async () => {
  const res = response();
  await getCallLogs(
    request({ query: { search: "alex", grouped: "true" } }),
    res,
  );
  const [[sql, params]] = expectFiltered();
  expect(params).toContain("alex");
  expect(sql).toContain("WITH calls AS");
});

test("message history is filtered to the member's lines", async () => {
  const res = response();
  await getMessageLogs(request(), res);
  expectFiltered();
  expect(res.json).toHaveBeenCalledWith([]);
});

test("the conversation list is filtered to the member's lines", async () => {
  const res = response();
  await conversations.list(request(), res);
  expectFiltered();
  expect(res.json).toHaveBeenCalledWith([]);
});

test("a thread typed by hand with the personal line as local is not found", async () => {
  const res = response();
  await conversations.thread(
    request({ query: { phone: "+12025550123", localNumber: PERSONAL } }),
    res,
  );
  expect(res.status).toHaveBeenCalledWith(404);
  expect(endpointCalls()).toHaveLength(0);
  // Same answer as a number that was never a line.
  const unknown = response();
  await conversations.thread(
    request({ query: { phone: "+12025550123", localNumber: "+12025550555" } }),
    unknown,
  );
  expect(unknown.status).toHaveBeenCalledWith(404);
  expect(unknown.json.mock.calls[0]).toEqual(res.json.mock.calls[0]);
});

test("a thread without a local number is filtered to the member's lines", async () => {
  const res = response();
  await conversations.thread(
    request({ query: { phone: "+12025550123" } }),
    res,
  );
  expectFiltered();
  expect(res.json).toHaveBeenCalledWith({ messages: [], hasMore: false });
});

test("unread counts only count the member's lines", async () => {
  pool.query.mockImplementation(async (sql) =>
    isScope(sql)
      ? { rows: scopeRows }
      : { rows: [{ calls: "0", messages: "0" }] },
  );
  const res = response();
  await activityViews.counts(request(), res);
  const [[sql]] = expectFiltered();
  // Both the call and the message count carry the filter.
  expect(sql.match(/left\(COALESCE/g)).toHaveLength(2);
  expect(res.json).toHaveBeenCalledWith({ calls: 0, messages: 0 });
});

test("marking a hidden call viewed has no effect and is not found", async () => {
  pool.query.mockImplementation(async (sql) =>
    isScope(sql)
      ? { rows: scopeRows }
      : { rows: [{ found: 0, inserted: 0 }], rowCount: 1 },
  );
  const res = response();
  await activityViews.markCall(request({ params: { id: "42" } }), res);
  expectFiltered();
  expect(res.sendStatus).toHaveBeenCalledWith(404);
  expect(publish).not.toHaveBeenCalled();
});

test("marking a conversation on the personal line has no effect and is not found", async () => {
  const res = response();
  await activityViews.markConversation(
    request({
      body: { phone: "+12025550123", throughId: "9", localNumber: PERSONAL },
    }),
    res,
  );
  expect(res.sendStatus).toHaveBeenCalledWith(404);
  expect(endpointCalls()).toHaveLength(0);
  expect(publish).not.toHaveBeenCalled();
});

test("marking a conversation without a local number is filtered", async () => {
  const res = response();
  await activityViews.markConversation(
    request({ body: { phone: "+12025550123", throughId: "9" } }),
    res,
  );
  expectFiltered();
  expect(res.sendStatus).toHaveBeenCalledWith(204);
});

const route = (method, path) => {
  const layer = callAssist.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

test.each([
  ["get", "/sessions/:sessionId", { sessionId: SESSION }],
  ["get", "/sessions/:sessionId/events", { sessionId: SESSION }],
  [
    "post",
    "/sessions/:sessionId/:action",
    { sessionId: SESSION, action: "stop" },
  ],
  ["patch", "/sessions/:sessionId", { sessionId: SESSION }],
  ["get", "/history/:callSid", { callSid: CALL_SID }],
  ["patch", "/history/:callSid", { callSid: CALL_SID }],
])(
  "Live Assist %s %s on a hidden line is not found",
  async (method, path, params) => {
    const res = response();
    await route(method, path)(
      request({ params, body: { notes: "x", outcome: null } }),
      res,
    );
    expectFiltered();
    expect(res.sendStatus).toHaveBeenCalledWith(404);
  },
);
