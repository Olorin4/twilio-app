const client = { query: jest.fn(), release: jest.fn() };
jest.mock("../../src/db", () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));
const pool = require("../../src/db");
const store = require("../../src/receptionist/store");
const { eventId } = require("../../src/outreachIntake/payload");
const { NO_SUMMARY } = require("../../src/receptionist/noSummary");

const sid = `CA${"3".repeat(32)}`;
const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE = "00000000-0000-4000-8000-000000000002";
const savedRow = (overrides = {}) => ({
  call_sid: sid,
  workspace_id: WORKSPACE,
  from_number: "+15551230009",
  started_at: new Date("2026-11-18T14:58:00.000Z"),
  ended_at: new Date("2026-11-18T15:03:40.000Z"),
  outcome: "lead",
  mc_verified: false,
  details: null,
  summary: null,
  transcript: [{ role: "caller", text: "hello" }],
  ...overrides,
});

// Answers each SQL statement; the receptionist_calls update returns `row`.
function respond(row, { outboxError, outboxRowCount = 1 } = {}) {
  client.query.mockImplementation(async (sql) => {
    if (/UPDATE receptionist_calls/.test(sql))
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    if (/INSERT INTO outreach_outbox/.test(sql)) {
      if (outboxError) throw outboxError;
      return { rows: [], rowCount: outboxRowCount };
    }
    return { rows: [], rowCount: 0 };
  });
}
const statements = () => client.query.mock.calls.map(([sql]) => sql.trim());
const outboxInserts = () =>
  client.query.mock.calls.filter(([sql]) => /outreach_outbox/.test(sql));

beforeEach(() => {
  jest.clearAllMocks();
  process.env.OUTREACH_INTAKE_WORKSPACE_ID = WORKSPACE;
  pool.connect.mockResolvedValue(client);
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  console.error.mockRestore();
  delete process.env.OUTREACH_INTAKE_WORKSPACE_ID;
});

describe("workspace scoping", () => {
  test("a lead in another workspace is never queued", async () => {
    respond(savedRow({ workspace_id: OTHER_WORKSPACE, summary: "x" }));
    await store.finishCall(sid, { outcome: "lead" });
    await store.updateSummary(sid, { outcome: "lead", summary: "x" });
    expect(outboxInserts()).toHaveLength(0);
    expect(statements()).not.toContain("SAVEPOINT outreach_event");
    expect(statements().pop()).toBe("COMMIT");
  });

  test("with no workspace configured nothing is queued, and that is logged once", async () => {
    jest.resetModules();
    jest.doMock("../../src/db", () => pool);
    const fresh = require("../../src/receptionist/store");
    delete process.env.OUTREACH_INTAKE_WORKSPACE_ID;
    respond(savedRow());
    await fresh.finishCall(sid, { outcome: "lead" });
    await fresh.finishCall(sid, { outcome: "lead" });
    expect(outboxInserts()).toHaveLength(0);
    const unset = console.error.mock.calls.filter(
      ([, code]) => code === "WORKSPACE_ID_UNSET",
    );
    expect(unset).toHaveLength(1);
  });

  test("the workspace id is matched case-insensitively", async () => {
    process.env.OUTREACH_INTAKE_WORKSPACE_ID = WORKSPACE.toUpperCase();
    respond(savedRow());
    await store.finishCall(sid, { outcome: "lead" });
    expect(outboxInserts()).toHaveLength(1);
  });
});

describe("finishCall", () => {
  test("a lead queues revision 1 in the same transaction", async () => {
    respond(savedRow());
    const row = await store.finishCall(sid, { outcome: "lead" });
    expect(row.call_sid).toBe(sid);
    const sql = statements();
    expect(sql[0]).toBe("BEGIN");
    expect(sql[1]).toMatch(/^UPDATE receptionist_calls/);
    expect(sql).toContain("SAVEPOINT outreach_event");
    expect(sql[sql.length - 1]).toBe("COMMIT");
    const [[insert, params]] = outboxInserts();
    expect(insert).toMatch(/ON CONFLICT DO NOTHING/);
    expect(params.slice(0, 4)).toEqual([
      eventId(sid, 1),
      sid,
      1,
      "jack.call.v1",
    ]);
    const payload = JSON.parse(params[4]);
    expect(payload.call.summary_status).toBe("PENDING");
    expect(JSON.stringify(payload)).not.toContain("transcript");
    expect(client.release).toHaveBeenCalled();
  });

  test.each(["not_a_lead", "spam", "abandoned", "failed"])(
    "a %s call is not queued",
    async (outcome) => {
      respond(savedRow({ outcome }));
      await store.finishCall(sid, { outcome });
      expect(outboxInserts()).toHaveLength(0);
      expect(statements()).not.toContain("SAVEPOINT outreach_event");
      expect(statements().pop()).toBe("COMMIT");
    },
  );

  test("an already closed call changes nothing and queues nothing", async () => {
    respond(null);
    expect(await store.finishCall(sid, { outcome: "lead" })).toBeNull();
    expect(outboxInserts()).toHaveLength(0);
  });

  test("a duplicate event is a no-op", async () => {
    respond(savedRow(), { outboxRowCount: 0 });
    const row = await store.finishCall(sid, { outcome: "lead" });
    expect(row.call_sid).toBe(sid);
    expect(statements().pop()).toBe("COMMIT");
  });

  test("a failed event insert still saves the call", async () => {
    respond(savedRow(), {
      outboxError: Object.assign(new Error("relation missing"), {
        code: "42P01",
      }),
    });
    const row = await store.finishCall(sid, { outcome: "lead" });
    expect(row.call_sid).toBe(sid);
    const sql = statements();
    expect(sql).toContain("ROLLBACK TO SAVEPOINT outreach_event");
    expect(sql.pop()).toBe("COMMIT");
    expect(console.error).toHaveBeenCalledWith(
      "Outreach event not queued:",
      "42P01",
    );
  });

  test("a failed call update rolls back and throws", async () => {
    client.query.mockImplementation(async (sql) => {
      if (/UPDATE/.test(sql)) throw new Error("boom");
      return { rows: [] };
    });
    await expect(store.finishCall(sid, { outcome: "lead" })).rejects.toThrow(
      "boom",
    );
    expect(statements()).toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalled();
  });
});

describe("updateSummary", () => {
  test("a lead with a summary queues revision 2 READY", async () => {
    respond(savedRow({ summary: "Wants dispatch." }));
    await store.updateSummary(sid, { outcome: "lead", summary: "x" });
    const [[, params]] = outboxInserts();
    expect(params[0]).toBe(eventId(sid, 2));
    expect(params[2]).toBe(2);
    const payload = JSON.parse(params[4]);
    expect(payload.call).toMatchObject({
      summary: "Wants dispatch.",
      summary_status: "READY",
    });
  });

  test("NO_SUMMARY queues revision 2 UNAVAILABLE", async () => {
    respond(savedRow({ summary: NO_SUMMARY }));
    await store.updateSummary(sid, { outcome: "lead", summary: NO_SUMMARY });
    const payload = JSON.parse(outboxInserts()[0][1][4]);
    expect(payload.call).toMatchObject({
      summary: null,
      summary_status: "UNAVAILABLE",
    });
  });

  test("a lead downgraded to not_a_lead queues revision 2 only if revision 1 exists", async () => {
    respond(savedRow({ outcome: "not_a_lead", summary: "Broker." }));
    await store.updateSummary(sid, { outcome: "not_a_lead" });
    const [[insert, params]] = outboxInserts();
    expect(insert).toMatch(
      /WHERE \$6::boolean OR EXISTS \(\s*SELECT 1 FROM outreach_outbox WHERE call_sid = \$2 AND revision = 1\)/,
    );
    expect(params[2]).toBe(2);
    expect(params[5]).toBe(false);
    const payload = JSON.parse(params[4]);
    expect(payload.call.outcome).toBe("not_a_lead");
    expect(payload.record.revision).toBe(2);
    expect(statements()).toContain("SAVEPOINT outreach_event");
    expect(statements().pop()).toBe("COMMIT");
  });

  test("a lead's insert is unconditional", async () => {
    respond(savedRow({ summary: "Wants dispatch." }));
    await store.updateSummary(sid, { outcome: "lead" });
    expect(outboxInserts()[0][1][5]).toBe(true);
  });

  test.each(["spam", "abandoned", "failed"])(
    "a %s summary queues nothing",
    async (outcome) => {
      respond(savedRow({ outcome }));
      await store.updateSummary(sid, { outcome });
      expect(outboxInserts()).toHaveLength(0);
    },
  );
});
