/* Queues Outreach events for lead calls closed since a date.
Usage: node scripts/outreach-intake-backfill.js --since <ISO> [--dry-run]
Prints counts only. Safe to rerun: existing events are left alone. */
require("dotenv").config({ quiet: true });
const pool = require("../src/db");
const { backfill } = require("../src/outreachIntake/backfill");

function parseArgs(argv) {
  const args = { dryRun: false, since: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--since") args.since = argv[++i] || null;
    else if (argv[i].startsWith("--since=")) args.since = argv[i].slice(8);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

async function main() {
  if (!process.env.DB_URL) throw new Error("DB_URL is required.");
  const { since, dryRun } = parseArgs(process.argv.slice(2));
  const counts = await backfill({ db: pool, since, dryRun });
  console.log(JSON.stringify(counts));
}

if (require.main === module)
  main()
    .catch((error) => {
      console.error("Outreach intake backfill failed:", error.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());

module.exports = { parseArgs };
