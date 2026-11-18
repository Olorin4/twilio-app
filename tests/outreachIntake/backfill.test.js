jest.mock("../../src/db", () => ({ query: jest.fn(), end: jest.fn() }));
const { backfill } = require("../../src/outreachIntake/backfill");
const { parseArgs } = require("../../scripts/outreach-intake-backfill");
const { eventId } = require("../../src/outreachIntake/payload");

const call = (n, summary) => ({
  call_sid: `CA${String(n).repeat(32)}`,
  from_number: "+15551230009",
  started_at: new Date("2026-11-10T14:00:00Z"),
  ended_at: new Date("2026-11-10T14:05:00Z"),
  outcome: "lead",
  mc_verified: false,
  details: null,
  summary,
});
const rows = [call(1, "Wants dispatch."), call(2, null)];

function fakeDb({ existing = 0, inserted = () => 1 } = {}) {
  return {
    query: jest.fn(async (sql, params) => {
      if (/FROM receptionist_calls/.test(sql)) return { rows };
      if (/SELECT count/.test(sql))
        return { rows: [{ count: String(existing) }] };
      if (/INSERT INTO outreach_outbox/.test(sql))
        return { rowCount: inserted(params) };
      throw new Error(`unexpected ${sql}`);
    }),
  };
}
const inserts = (db) =>
  db.query.mock.calls.filter(([sql]) => /INSERT/.test(sql));

test("dry run counts without writing", async () => {
  const db = fakeDb({ existing: 1 });
  const counts = await backfill({ db, since: "2026-11-01", dryRun: true });
  expect(counts).toEqual({
    calls: 2,
    events: 3,
    queued: 2,
    existing: 1,
    dryRun: true,
  });
  expect(inserts(db)).toHaveLength(0);
  const lookup = db.query.mock.calls.find(([sql]) => /count/.test(sql));
  expect(lookup[1][0]).toEqual([
    eventId(rows[0].call_sid, 1),
    eventId(rows[0].call_sid, 2),
    eventId(rows[1].call_sid, 1),
  ]);
});

test("only closed lead calls since the date are read", async () => {
  const db = fakeDb();
  await backfill({ db, since: "2026-11-01T00:00:00Z", dryRun: true });
  const [sql, params] = db.query.mock.calls[0];
  expect(sql).toMatch(/outcome = 'lead' AND ended_at IS NOT NULL/);
  expect(params[0]).toEqual(new Date("2026-11-01T00:00:00Z"));
});

test("queues revision 1 for each lead and revision 2 when summarised", async () => {
  const db = fakeDb();
  const counts = await backfill({ db, since: "2026-11-01" });
  expect(counts).toMatchObject({ calls: 2, events: 3, queued: 3, existing: 0 });
  expect(inserts(db).map(([, p]) => [p[1], p[2]])).toEqual([
    [rows[0].call_sid, 1],
    [rows[0].call_sid, 2],
    [rows[1].call_sid, 1],
  ]);
  const rev2 = JSON.parse(inserts(db)[1][1][4]);
  expect(rev2.call.summary_status).toBe("READY");
  expect(rev2.occurred_at).toBe("2026-11-10T14:05:00.000Z");
});

test("a rerun is a no-op", async () => {
  const db = fakeDb({ inserted: () => 0 });
  const counts = await backfill({ db, since: "2026-11-01" });
  expect(counts).toMatchObject({ queued: 0, existing: 3 });
});

test("rejects a missing or bad date", async () => {
  await expect(backfill({ db: fakeDb(), since: null })).rejects.toThrow(
    /--since/,
  );
  await expect(backfill({ db: fakeDb(), since: "soon" })).rejects.toThrow(
    /--since/,
  );
});

test("parses the command line", () => {
  expect(parseArgs(["--since", "2026-11-01", "--dry-run"])).toEqual({
    since: "2026-11-01",
    dryRun: true,
  });
  expect(parseArgs(["--since=2026-11-01"])).toEqual({
    since: "2026-11-01",
    dryRun: false,
  });
  expect(() => parseArgs(["--all"])).toThrow(/Unknown/);
});
