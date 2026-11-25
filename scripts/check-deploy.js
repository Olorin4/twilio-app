// Deploy gate: exits 1, listing every problem, unless production's database
// and settings are ready for this code. Read-only. The deploy job runs it in
// the newly built image (docker compose run --rm --no-deps app …), so DB_URL
// and the rest come from the server's .env through compose's env_file.
require("dotenv").config({ quiet: true });
const pool = require("../src/db");
const { checkDeployReadiness } = require("../src/deployCheck");

async function main() {
  if (!process.env.DB_URL) throw new Error("DB_URL is required.");
  const { ok, problems } = await checkDeployReadiness(pool);
  if (ok) {
    console.log("Deploy check passed: database and settings are ready.");
    return;
  }
  console.error("Deploy check failed:");
  for (const problem of problems) console.error(`- ${problem}`);
  process.exitCode = 1;
}
main()
  .catch((error) => {
    // The deploy job's output is public: print the error code only.
    console.error("Deploy check failed:", error.code || "error");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
