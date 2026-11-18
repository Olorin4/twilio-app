/* Opt-in checks against a real Postgres. Runs only when
OUTREACH_INTAKE_PG_TEST=1 and DB_URL names a database ending in _test; the
outbox and receptionist_calls tables there are dropped and recreated. */

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { enqueue } = require("../../src/outreachIntake/outbox");
const { claim, BATCH } = require("../../src/outreachIntake/sender");

function testDatabaseUrl() {
  if (process.env.OUTREACH_INTAKE_PG_TEST !== "1") return null;
  try {
    const url = new URL(process.env.DB_URL || "");
    return /_test$/.test(decodeURIComponent(url.pathname.slice(1)))
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

const dbUrl = testDatabaseUrl();
const describeDb = dbUrl ? describe : describe.skip;

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const env = { OUTREACH_INTAKE_WORKSPACE_ID: WORKSPACE };
const migration = (name) =>
  fs.readFileSync(path.join(__dirname, "../../migrations", name), "utf8");
const lead = (n) => ({
  call_sid: `CA${String(n).padStart(32, "0")}`,
  workspace_id: WORKSPACE,
  from_number: "+15551230009",
  started_at: new Date("2026-11-18T14:58:00Z"),
  ended_at: new Date("2026-11-18T15:03:40Z"),
  outcome: "lead",
  mc_verified: false,
  details: null,
  summary: null,
});

describeDb("outreach_outbox on Postgres", () => {
  let pool;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: dbUrl,
      ssl: process.env.DB_SSL === "false" ? false : undefined,
    });
    await pool.query(
      "DROP TABLE IF EXISTS outreach_outbox, receptionist_calls",
    );
    await pool.query(migration("007_receptionist_calls.sql"));
    await pool.query(migration("009_outreach_outbox.sql"));
  });
  beforeEach(() => pool.query("TRUNCATE outreach_outbox RESTART IDENTITY"));
  afterAll(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS outreach_outbox, receptionist_calls",
    );
    await pool.end();
  });

  test("the same (call_sid, revision) twice stores one row", async () => {
    expect(await enqueue(pool, lead(1), 1, { env })).toBe(true);
    expect(await enqueue(pool, lead(1), 1, { env })).toBe(false);
    // A second insert with a different event id still hits (call_sid, revision).
    await pool.query(
      `INSERT INTO outreach_outbox (event_id, call_sid, revision, contract, payload)
       VALUES (gen_random_uuid(), $1, 1, 'jack.call.v1', '{}'::jsonb)
       ON CONFLICT DO NOTHING`,
      [lead(1).call_sid],
    );
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM outreach_outbox WHERE call_sid = $1",
      [lead(1).call_sid],
    );
    expect(rows[0].n).toBe(1);
  });

  test("a second claim within the lease returns nothing", async () => {
    await enqueue(pool, lead(1), 1, { env });
    await enqueue(pool, lead(2), 1, { env });
    expect(await claim(pool)).toHaveLength(2);
    expect(await claim(pool)).toEqual([]);
    const { rows } = await pool.query(
      "SELECT bool_and(next_attempt_at > now() + interval '1 minute') AS leased FROM outreach_outbox",
    );
    expect(rows[0].leased).toBe(true);
  });

  test("claims the oldest due events first, returned in queue order", async () => {
    const count = BATCH + 1;
    for (let n = 1; n <= count; n += 1)
      await enqueue(pool, lead(n), 1, { env });
    // Row 1 became due last; the newest row has waited longest.
    await pool.query(
      `UPDATE outreach_outbox
       SET next_attempt_at = now() - make_interval(secs => id * 60)`,
    );
    await pool.query(
      "UPDATE outreach_outbox SET next_attempt_at = now() - interval '1 second' WHERE id = 1",
    );
    // One event not yet due is never claimed.
    await enqueue(pool, lead(99), 1, { env });
    await pool.query(
      "UPDATE outreach_outbox SET next_attempt_at = now() + interval '1 hour' WHERE call_sid = $1",
      [lead(99).call_sid],
    );
    const claimed = (await claim(pool)).map((row) => Number(row.id));
    expect(claimed).toHaveLength(BATCH);
    expect(claimed).not.toContain(1);
    expect(claimed).toEqual(Array.from({ length: BATCH }, (_, i) => i + 2));
    // The next run takes what is left and due.
    expect((await claim(pool)).map((row) => Number(row.id))).toEqual([1]);
  });
});
