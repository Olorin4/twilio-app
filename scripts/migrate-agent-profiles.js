require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const pool = require("../src/db");
async function main() {
  if (!process.env.DB_URL) throw new Error("DB_URL is required.");
  await pool.query(
    fs.readFileSync(
      path.join(__dirname, "../migrations/013_agent_profiles.sql"),
      "utf8",
    ),
  );
  console.log("Agent profiles schema is ready.");
}
main()
  .catch((error) => {
    console.error("Agent profiles migration failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
