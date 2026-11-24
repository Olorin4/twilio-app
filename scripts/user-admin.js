/* Command-line recovery that needs no login. Set the password without
leaving it in shell history:
     read -rs USER_PASSWORD; export USER_PASSWORD
     npm run users -- create-owner <username>
     npm run users -- reset-password <username>
The password comes only from the environment; nothing secret is printed. A
running server re-checks the password hash on every login, so a reset takes
effect there immediately. */
require("dotenv").config({ quiet: true });
const pool = require("../src/db");
const users = require("../src/users");

const USAGE =
  "Usage: read -rs USER_PASSWORD; export USER_PASSWORD; npm run users -- create-owner|reset-password <username>";

async function main() {
  if (!process.env.DB_URL) throw new Error("DB_URL is required.");
  const [command, rawName] = process.argv.slice(2);
  if (!["create-owner", "reset-password"].includes(command) || !rawName)
    throw new Error(USAGE);
  const username = users.normalizeUsername(rawName);
  const password = process.env.USER_PASSWORD;
  if (!password) throw new Error("USER_PASSWORD is required.");

  if (command === "create-owner") {
    await users.createUser({ username, password, role: "owner" });
    console.log(`Owner ${username} created.`);
    return;
  }
  const { rows } = await pool.query(
    "SELECT id FROM app_users WHERE username = $1",
    [username],
  );
  if (!rows[0]) throw new Error("User does not exist.");
  await users.setPassword(rows[0].id, password);
  console.log(`Password for ${username} reset.`);
}
main()
  .catch((error) => {
    console.error("User admin failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
