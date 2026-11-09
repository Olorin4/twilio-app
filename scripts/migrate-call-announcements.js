require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const pool = require("../src/db");
async function main() {
  if (!process.env.DB_URL) throw new Error("DB_URL is required.");
  await pool.query(
    fs.readFileSync(
      path.join(__dirname, "../migrations/006_call_announcements.sql"),
      "utf8",
    ),
  );
  console.log("Call announcement table is ready.");
}
main()
  .catch((error) => {
    console.error("Call announcement migration failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
