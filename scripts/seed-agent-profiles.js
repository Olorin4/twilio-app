require("dotenv").config({ quiet: true });
const pool = require("../src/db");
const { seedJack } = require("../src/agentProfiles");

async function main() {
  if (!process.env.DB_URL) throw new Error("DB_URL is required.");
  const { created } = await seedJack();
  console.log(
    created
      ? "Jack profile created."
      : "Jack profile already exists; nothing changed.",
  );
}
main()
  .catch((error) => {
    console.error("Agent profile seed failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
