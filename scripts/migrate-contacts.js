require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const pool = require("../src/db");

async function main() {
  if (!process.env.DB_URL) throw new Error("DB_URL is required.");
  const sql = fs.readFileSync(
    path.join(__dirname, "../migrations/001_phone_contacts.sql"),
    "utf8",
  );
  await pool.query(sql);
  console.log("Contacts table is ready.");
}

main()
  .catch((error) => {
    console.error("Contacts migration failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
