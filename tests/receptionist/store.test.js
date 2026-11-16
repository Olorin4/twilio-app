jest.mock("../../src/db", () => ({ query: jest.fn() }));
const pool = require("../../src/db");
const store = require("../../src/receptionist/store");

const sid = `CA${"1".repeat(32)}`;
const ws = "00000000-0000-4000-8000-000000000001";

beforeEach(() => jest.clearAllMocks());

test("startCall records the call once", async () => {
  pool.query.mockResolvedValue({ rowCount: 1 });
  await store.startCall({
    callSid: sid,
    workspaceId: ws,
    connectionId: null,
    from: "+15551230009",
  });
  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toMatch(/ON CONFLICT \(call_sid\) DO NOTHING/);
  expect(params).toEqual([sid, ws, null, "+15551230009"]);
});

test("finishCall only closes an open call and serialises json fields", async () => {
  pool.query.mockResolvedValue({ rows: [{ call_sid: sid }], rowCount: 1 });
  const row = await store.finishCall(sid, {
    outcome: "lead",
    transcript: [{ role: "caller", text: "hi" }],
    carrier: { legalName: "X" },
  });
  const [sql, params] = pool.query.mock.calls[0];
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

test("countAgentCalls returns a number", async () => {
  pool.query.mockResolvedValue({ rows: [{ count: "2" }] });
  expect(await store.countAgentCalls("+15551230001")).toBe(2);
  expect(pool.query.mock.calls[0][1]).toEqual(["+15551230001", 24]);
});

test("listCalls hides calls still in progress and reports stale ones as failed", async () => {
  pool.query.mockResolvedValue({ rows: [{ call_sid: sid }] });
  expect(await store.listCalls(ws)).toEqual([{ call_sid: sid }]);
  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toMatch(/ended_at IS NOT NULL OR started_at < now\(\) - /);
  expect(sql).toMatch(/COALESCE\(outcome, 'failed'\) AS outcome/);
  expect(params).toEqual([ws, 50]);
});

test("countNew counts unhandled leads and messages only", async () => {
  pool.query.mockResolvedValue({ rows: [{ count: "4" }] });
  expect(await store.countNew(ws)).toBe(4);
  expect(pool.query.mock.calls[0][0]).toMatch(
    /status = 'new' AND outcome IN \('lead', 'not_a_lead'\)/,
  );
});
