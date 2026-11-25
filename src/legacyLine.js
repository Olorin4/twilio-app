/* The legacy Iron Wing setup (TWILIO_CALLER_ID and TWILIO_PREVIOUS_NUMBERS,
answered on /voice and /sms) steps aside for a number once it is also a line
of an Iron Wing connection: that number is "moved". Adding it to the
connection is the switch; releasing it is the rollback. See
docs/superpowers/specs/2026-11-25-main-number-into-iron-wing-connection-design.md. */

const pool = require("./db");
const { IRON_WING_WORKSPACE_ID } = require("./workspaceContext");

// Required lazily: conversations.js and visibility.js require each other.
const legacyNumbers = () => require("./conversations").numbers();

async function movedLegacyNumbers(db = pool) {
  const legacy = legacyNumbers();
  if (!legacy.length) return [];
  const { rows } = await db.query(
    `SELECT DISTINCT n.phone_number
     FROM connection_numbers n JOIN provider_connections c ON c.id = n.connection_id
     WHERE c.workspace_id = $1 AND n.phone_number = ANY($2::text[])`,
    [IRON_WING_WORKSPACE_ID, legacy],
  );
  const moved = new Set(rows.map((row) => row.phone_number));
  return legacy.filter((number) => moved.has(number));
}

// True when the main number (TWILIO_CALLER_ID) is moved.
async function legacyMoved(db = pool) {
  const main = (process.env.TWILIO_CALLER_ID || "").trim();
  if (!main) return false;
  return (await movedLegacyNumbers(db)).includes(main);
}

module.exports = { movedLegacyNumbers, legacyMoved };
