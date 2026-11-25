/* Deploy gate: whether production's database and settings are ready for this
code. Run by the deploy job inside the newly built image, before the running
container is replaced (scripts/check-deploy.js). It only reads; migrations
stay a manual, owner-approved step. Returns every problem at once. */
const { IRON_WING_WORKSPACE_ID } = require("./workspaceContext");
const { trustProxySetting } = require("./security");
const { countRepairableSessionLines } = require("./callAssist/sessionLines");

const SCHEMA_SQL = `SELECT
  EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'connection_numbers'
      AND column_name = 'handler') AS handler_column,
  EXISTS (SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'agent_profiles') AS agent_profiles_table,
  EXISTS (SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'app_users') AS users_table,
  EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'connection_numbers'
      AND column_name = 'personal') AS personal_column`;

function environmentProblems(env) {
  const problems = [];
  let trust;
  try {
    trust = trustProxySetting(env.TRUST_PROXY);
  } catch (error) {
    problems.push(error.message);
  }
  if (trust === false)
    problems.push(
      "TRUST_PROXY is not set: production runs behind the edge nginx and needs TRUST_PROXY=1.",
    );
  if (!String(env.TWILIO_IDENTITY ?? "").trim())
    problems.push(
      "TWILIO_IDENTITY is not set: production needs a fixed identity for the legacy number.",
    );
  return problems;
}

async function databaseProblems(db) {
  const problems = [];
  const {
    rows: [schema],
  } = await db.query(SCHEMA_SQL);
  if (!schema.handler_column)
    problems.push(
      "Migration 013 has not run: connection_numbers.handler is missing (npm run migrate:agent-profiles).",
    );
  if (!schema.agent_profiles_table)
    problems.push(
      "Migration 013 has not run: the agent_profiles table is missing (npm run migrate:agent-profiles).",
    );
  else {
    const {
      rows: [jack],
    } = await db.query(
      `SELECT EXISTS (SELECT 1 FROM agent_profiles
        WHERE workspace_id = $1 AND is_default) AS jack_imported`,
      [IRON_WING_WORKSPACE_ID],
    );
    if (!jack.jack_imported)
      problems.push(
        "Jack has not been imported: Iron Wing has no default agent profile (npm run seed:agent-profiles).",
      );
  }
  if (!schema.users_table)
    problems.push(
      "Migration 014 has not run: the app_users table is missing (npm run migrate:users).",
    );
  if (!schema.personal_column)
    problems.push(
      "Migration 014 has not run: connection_numbers.personal is missing (npm run migrate:users).",
    );
  const repairable = await countRepairableSessionLines(db);
  if (repairable > 0)
    problems.push(
      `Migration 015 has not run: ${repairable} Live Assist sessions still hold a softphone identity (npm run migrate:session-lines).`,
    );
  return problems;
}

async function checkDeployReadiness(db, env = process.env) {
  let problems;
  try {
    problems = await databaseProblems(db);
  } catch (error) {
    return {
      ok: false,
      problems: [`Could not read the database: ${error.message}`],
    };
  }
  problems.push(...environmentProblems(env));
  return { ok: problems.length === 0, problems };
}

module.exports = { checkDeployReadiness };
