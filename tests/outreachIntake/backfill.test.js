jest.mock("../../src/db", () => ({ query: jest.fn(), end: jest.fn() }));
const { backfill } = require("../../src/outreachIntake/backfill");
const { parseArgs } = require("../../scripts/outreach-intake-backfill");

const call = (n, summary, outcome = "lead") => ({
  call_sid: `CA${String(n).repeat(32)}`,
  from_number: "+15551230009",
  started_at: new Date("2026-11-10T14:00:00Z"),
  ended_at: new Date("2026-11-10T14:05:00Z"),
  outcome,
  mc_verified: false,
  details: null,
  summary,
});
const lead1 = call(1, "Wants dispatch.");
const lead2 = call(2, null);
const leads = [lead1, lead2];
// Downgraded after a lead was reported (3) and never reported (4).
const downgraded = call(3, "Broker.", "not_a_lead");
const neverLead = call(4, "Driver.", "not_a_lead");

// A fake db: `rows` are the calls; `outbox` lists "call_sid:revision" pairs
// already queued; `inserted` decides each insert's rowCount.
function fakeDb({ rows = leads, outbox = [], inserted = () => 1 } = {}) {
  return {
    query: jest.fn(async (sql, params) => {
      if (/FROM receptionist_calls/.test(sql)) return { rows };
      if (/SELECT call_sid, revision FROM outreach_outbox/.test(sql))
        return {
          rows: outbox.map((key) => {
            const [call_sid, revision] = key.split(":");
            return { call_sid, revision: Number(revision) };
          }),
        };
      if (/INSERT INTO outreach_outbox/.test(sql))
        return { rowCount: inserted(params) };
      throw new Error(`unexpected ${sql}`);
    }),
  };
}
const inserts = (db) =>
  db.query.mock.calls.filter(([sql]) => /INSERT/.test(sql));

test("dry run counts without writing", async () => {
  const db = fakeDb({ outbox: [`${lead1.call_sid}:1`] });
  const counts = await backfill({ db, since: "2026-11-01", dryRun: true });
  expect(counts).toEqual({
    calls: 2,
    events: 3,
    queued: 2,
    existing: 1,
    skipped: 0,
    dryRun: true,
  });
  expect(inserts(db)).toHaveLength(0);
  const lookup = db.query.mock.calls.find(([sql]) =>
    /FROM outreach_outbox/.test(sql),
  );
  expect(lookup[1][0]).toEqual([lead1.call_sid, lead2.call_sid]);
});

test("only closed lead (or summarised not_a_lead) calls since the date are read", async () => {
  const db = fakeDb();
  await backfill({ db, since: "2026-11-01T00:00:00Z", dryRun: true });
  const [sql, params] = db.query.mock.calls[0];
  expect(sql).toMatch(/ended_at IS NOT NULL/);
  expect(sql).toMatch(
    /outcome = 'lead' OR \(outcome = 'not_a_lead' AND summary IS NOT NULL\)/,
  );
  expect(params[0]).toEqual(new Date("2026-11-01T00:00:00Z"));
});

test("queues revision 1 for each lead and revision 2 when summarised", async () => {
  const db = fakeDb();
  const counts = await backfill({ db, since: "2026-11-01" });
  expect(counts).toMatchObject({ calls: 2, events: 3, queued: 3, existing: 0 });
  expect(inserts(db).map(([, p]) => [p[1], p[2]])).toEqual([
    [lead1.call_sid, 1],
    [lead1.call_sid, 2],
    [lead2.call_sid, 1],
  ]);
  const rev2 = JSON.parse(inserts(db)[1][1][4]);
  expect(rev2.call.summary_status).toBe("READY");
  expect(rev2.occurred_at).toBe("2026-11-10T14:05:00.000Z");
});

test("a rerun is a no-op", async () => {
  const db = fakeDb({
    outbox: [
      `${lead1.call_sid}:1`,
      `${lead1.call_sid}:2`,
      `${lead2.call_sid}:1`,
    ],
  });
  const counts = await backfill({ db, since: "2026-11-01" });
  expect(counts).toMatchObject({ queued: 0, existing: 3 });
  expect(inserts(db)).toHaveLength(0);
});

test("a not_a_lead call gets revision 2 only when revision 1 was sent", async () => {
  const db = fakeDb({
    rows: [downgraded, neverLead],
    outbox: [`${downgraded.call_sid}:1`],
  });
  const counts = await backfill({ db, since: "2026-11-01" });
  expect(counts).toMatchObject({ calls: 2, events: 2, queued: 1, skipped: 1 });
  const [[, params]] = inserts(db);
  expect([params[1], params[2]]).toEqual([downgraded.call_sid, 2]);
  expect(JSON.parse(params[4]).call.outcome).toBe("not_a_lead");
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
