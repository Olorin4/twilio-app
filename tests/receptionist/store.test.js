jest.mock("../../src/db", () => ({ query: jest.fn(), connect: jest.fn() }));
const pool = require("../../src/db");
const store = require("../../src/receptionist/store");

const sid = `CA${"1".repeat(32)}`;
const ws = "00000000-0000-4000-8000-000000000001";
const profileId = "00000000-0000-4000-8000-0000000000a1";

// finishCall and updateSummary run in a transaction on a pooled client; the
// fake client sends its statements through pool.query so they can be seen.
beforeEach(() => {
  jest.clearAllMocks();
  pool.connect.mockResolvedValue({
    query: (...args) => pool.query(...args),
    release: jest.fn(),
  });
});
const callUpdate = () =>
  pool.query.mock.calls.find(([sql]) => /UPDATE receptionist_calls/.test(sql));

test("startCall records the call once", async () => {
  pool.query.mockResolvedValue({ rowCount: 1 });
  await store.startCall({
    callSid: sid,
    workspaceId: ws,
    connectionId: null,
    from: "+15551230009",
    agentProfileId: profileId,
  });
  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toMatch(/ON CONFLICT \(call_sid\) DO NOTHING/);
  expect(sql).toMatch(/agent_profile_id/);
  expect(params).toEqual([sid, ws, null, "+15551230009", profileId]);
});

test("startCall without a profile stores a null profile", async () => {
  pool.query.mockResolvedValue({ rowCount: 1 });
  await store.startCall({ callSid: sid, workspaceId: ws, from: "x" });
  expect(pool.query.mock.calls[0][1]).toEqual([sid, ws, null, "x", null]);
});

test("finishCall only closes an open call and serialises json fields", async () => {
  pool.query.mockResolvedValue({ rows: [{ call_sid: sid }], rowCount: 1 });
  const row = await store.finishCall(sid, {
    outcome: "lead",
    transcript: [{ role: "caller", text: "hi" }],
    carrier: { legalName: "X" },
  });
  const [sql, params] = callUpdate();
  expect(sql).toMatch(/ended_at IS NULL/);
  expect(params[0]).toBe(sid);
  expect(params).toContain("lead");
  expect(params).toContain(JSON.stringify([{ role: "caller", text: "hi" }]));
  expect(params).toContain(JSON.stringify({ legalName: "X" }));
  expect(row).toEqual({ call_sid: sid });
});

test("finishCall returns null when the call was already closed", async () => {
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  expect(await store.finishCall(sid, { outcome: "lead" })).toBeNull();
});

test("finishCall rejects an unknown outcome without querying", async () => {
  await expect(store.finishCall(sid, { outcome: "won" })).rejects.toThrow(
    /outcome/,
  );
  expect(pool.query).not.toHaveBeenCalled();
});

test("setStatus rejects unknown statuses without querying", async () => {
  expect(await store.setStatus(ws, sid, "deleted")).toBe(false);
  expect(pool.query).not.toHaveBeenCalled();
});

test("setStatus reports whether a row in the workspace changed", async () => {
  pool.query.mockResolvedValueOnce({ rowCount: 1 });
  expect(await store.setStatus(ws, sid, "called")).toBe(true);
  expect(pool.query.mock.calls[0][1]).toEqual([ws, sid, "called"]);
  pool.query.mockResolvedValueOnce({ rowCount: 0 });
  expect(await store.setStatus(ws, sid, "called")).toBe(false);
});

test("countAgentCalls counts one caller's calls to one profile", async () => {
  pool.query.mockResolvedValue({ rows: [{ count: "2" }] });
  expect(await store.countAgentCalls("+15551230001", profileId)).toBe(2);
  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toMatch(/agent_profile_id = \$2/);
  expect(params).toEqual(["+15551230001", profileId, 24]);
  await store.countAgentCalls("+15551230001", profileId, 6);
  expect(pool.query.mock.calls[1][1]).toEqual(["+15551230001", profileId, 6]);
});

test("listCalls hides calls still in progress and reports stale ones as failed", async () => {
  pool.query.mockResolvedValue({ rows: [{ call_sid: sid }] });
  expect(await store.listCalls(ws)).toEqual([{ call_sid: sid }]);
  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toMatch(/ended_at IS NOT NULL OR started_at < now\(\) - /);
  expect(sql).toMatch(/COALESCE\(outcome, 'failed'\) AS outcome/);
  expect(params).toEqual([ws, 50]);
});

test("countNew counts unhandled calls that are owed a callback", async () => {
  pool.query.mockResolvedValue({ rows: [{ count: "4" }] });
  expect(await store.countNew(ws)).toBe(4);
  const sql = pool.query.mock.calls[0][0];
  expect(sql).toMatch(/status = 'new'/);
  expect(sql).toMatch(/outcome IN \('lead', 'not_a_lead', 'failed'\)/);
});

test("countNew also counts a call that was never closed, as the list shows it", async () => {
  pool.query.mockResolvedValue({ rows: [{ count: "1" }] });
  await store.countNew(ws);
  expect(pool.query.mock.calls[0][0]).toMatch(
    /outcome IS NULL AND started_at < now\(\) - interval '15 minutes'/,
  );
});

test("updateSummary fills in a saved call without reopening it", async () => {
  pool.query.mockResolvedValue({ rows: [{ call_sid: sid }], rowCount: 1 });
  const row = await store.updateSummary(sid, {
    outcome: "not_a_lead",
    callerName: "Dana",
    summary: "Broker.",
    script: { opener: "Hi" },
    details: { interest: "low" },
  });
  const [sql, params] = callUpdate();
  expect(sql).toMatch(/UPDATE receptionist_calls/);
  expect(sql).toMatch(/ended_at IS NOT NULL/);
  expect(sql).not.toMatch(/transcript =/);
  expect(params[0]).toBe(sid);
  expect(params).toContain("not_a_lead");
  expect(params).toContain(JSON.stringify({ opener: "Hi" }));
  expect(row).toEqual({ call_sid: sid });
});

test("discardCall removes only a call that never started", async () => {
  pool.query.mockResolvedValue({ rowCount: 1 });
  await store.discardCall(sid);
  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toMatch(/DELETE FROM receptionist_calls/);
  expect(sql).toMatch(/ended_at IS NULL/);
  expect(params).toEqual([sid]);
});

test("saveCosts records usage and both cost figures on the call", async () => {
  pool.query.mockResolvedValue({ rowCount: 1 });
  const usage = [{ model: "claude-opus-5-5", speed: "fast", requests: 7 }];
  await store.saveCosts(sid, { usage, claudeCost: 0.2134, relayCost: 0.14 });
  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toMatch(/UPDATE receptionist_calls/);
  expect(sql).toMatch(/usage = \$2::jsonb/);
  expect(sql).toMatch(/WHERE call_sid = \$1/);
  expect(params).toEqual([sid, JSON.stringify(usage), 0.2134, 0.14]);
});

test("saveCosts stores unknown costs as null", async () => {
  pool.query.mockResolvedValue({ rowCount: 1 });
  await store.saveCosts(sid, { usage: [], claudeCost: null, relayCost: null });
  expect(pool.query.mock.calls[0][1]).toEqual([sid, "[]", null, null]);
});
