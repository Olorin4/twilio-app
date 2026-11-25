require("dotenv").config({ quiet: true });
const pool = require("../src/db");
const { backfillSessionLines } = require("../src/callAssist/sessionLines");

// Migration 015: store the line a softphone call used on Live Assist sessions
// that still hold the softphone identity. Pass DB_URL explicitly.
async function main() {
  if (!process.env.DB_URL) throw new Error("DB_URL is required.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Fail fast instead of queueing behind live traffic; rerun if it times out.
    await client.query("SET LOCAL lock_timeout = '5s'");
    const repaired = await backfillSessionLines(client);
    await client.query("COMMIT");
    console.log(`Session lines are ready (${repaired} repaired).`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
main()
  .catch((error) => {
    console.error("Session lines migration failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
