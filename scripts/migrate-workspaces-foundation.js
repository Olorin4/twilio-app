require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const pool = require("../src/db");
async function main() {
  if (!process.env.DB_URL) throw new Error("DB_URL is required.");
  const sql = fs.readFileSync(
    path.join(__dirname, "../migrations/005_workspaces_foundation.sql"),
    "utf8",
  );
  const client = await pool.connect();
  try {
    await client.query(sql);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  console.log("Workspace foundation is ready.");
}
main()
  .catch((error) => {
    console.error("Workspace migration failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
