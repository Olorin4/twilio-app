const twilio = require("twilio");
const pool = require("./db");
const { decryptCredentials } = require("./credentialEncryption");
const { IRON_WING_WORKSPACE_ID } = require("./workspaceContext");
const { legacyMoved } = require("./legacyLine");
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function legacyProvider(workspaceId) {
  if (workspaceId !== IRON_WING_WORKSPACE_ID)
    throw new Error("Legacy connection is unavailable in this workspace.");
  const legacy = require("./token");
  return {
    legacy: true,
    workspaceId,
    accountSid: legacy.accountSid,
    authToken: legacy.authToken,
    apiKeySid: legacy.apiKey,
    apiKeySecret: legacy.apiSecret,
    twimlAppSid: legacy.appSid,
    phoneNumber: legacy.callerId,
    client: legacy.client,
    voiceEnabled: true,
    smsEnabled: true,
    handler: "legacy",
    agentProfileId: null,
    numberLabel: null,
    observeHours: true,
  };
}
async function getProvider(workspaceId, requestedNumberId) {
  if (
    !uuidPattern.test(workspaceId || "") ||
    (requestedNumberId && !uuidPattern.test(requestedNumberId))
  )
    throw new Error("Invalid workspace or number.");
  const result = await pool.query(
    `SELECT c.id, c.workspace_id, c.account_sid, c.encrypted_credentials,
      n.id AS number_id, n.phone_number, n.voice_enabled, n.sms_enabled,
      n.handler, n.agent_profile_id, n.label, n.observe_hours
    FROM workspace_active_numbers a JOIN connection_numbers n ON n.id = COALESCE($2::uuid, a.connection_number_id)
      JOIN provider_connections c ON c.id = n.connection_id
    WHERE a.workspace_id = $1 AND c.workspace_id = $1
    UNION ALL
    SELECT c.id, c.workspace_id, c.account_sid, c.encrypted_credentials,
      n.id AS number_id, n.phone_number, n.voice_enabled, n.sms_enabled,
      n.handler, n.agent_profile_id, n.label, n.observe_hours
    FROM connection_numbers n JOIN provider_connections c ON c.id = n.connection_id
    WHERE $2::uuid IS NOT NULL AND n.id = $2 AND c.workspace_id = $1
      AND NOT EXISTS (SELECT 1 FROM workspace_active_numbers a WHERE a.workspace_id = $1)
    LIMIT 1`,
    [workspaceId, requestedNumberId || null],
  );
  if (!result.rows.length) {
    // Once the main number is moved into the connection, a line must be
    // chosen; there is no legacy fallback.
    if (
      workspaceId === IRON_WING_WORKSPACE_ID &&
      !requestedNumberId &&
      !(await legacyMoved())
    ) {
      return legacyProvider(workspaceId);
    }
    throw new Error("No phone number is selected for this workspace.");
  }
  const row = result.rows[0];
  const secrets = decryptCredentials(row.id, row.encrypted_credentials);
  return {
    legacy: false,
    id: row.id,
    numberId: row.number_id,
    workspaceId: row.workspace_id,
    accountSid: row.account_sid,
    phoneNumber: row.phone_number,
    voiceEnabled: row.voice_enabled,
    smsEnabled: row.sms_enabled,
    numberLabel: row.label ?? null,
    handler: row.handler ?? "softphone",
    agentProfileId: row.agent_profile_id ?? null,
    observeHours: row.observe_hours ?? true,
    authToken: secrets.authToken,
    apiKeySid: secrets.apiKeySid,
    apiKeySecret: secrets.apiKeySecret,
    twimlAppSid: secrets.twimlAppSid,
    client: twilio(row.account_sid, secrets.authToken),
  };
}
async function getProviderForWebhook(connection, phoneNumber) {
  if (!/^\+[1-9]\d{1,14}$/.test(phoneNumber || ""))
    throw new Error("Invalid configured number.");
  const result = await pool.query(
    "SELECT id FROM connection_numbers WHERE connection_id = $1 AND phone_number = $2",
    [connection.id, phoneNumber],
  );
  if (!result.rows.length)
    throw new Error("Number is not assigned to this connection.");
  const provider = await getProvider(connection.workspaceId, result.rows[0].id);
  if (provider.id !== connection.id)
    throw new Error("Connection does not own this number.");
  return provider;
}
// Run once at startup. getProvider reads the columns migration 013 adds, so
// code deployed before that migration breaks inbound calls on connection
// numbers, outgoing calls and softphone tokens in every workspace. Logs
// loudly and never throws: true when the column exists, false when it is
// missing, null when the check itself could not run.
async function checkNumberSchema() {
  try {
    const result = await pool.query(
      `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
      ["connection_numbers", "handler"],
    );
    if (result.rows.length) return true;
    console.error(
      "DATABASE NOT MIGRATED: connection_numbers.handler is missing. Inbound calls on connection numbers, outgoing calls and softphone tokens will fail in every workspace until `npm run migrate:agent-profiles` (migration 013) is run.",
    );
    return false;
  } catch (error) {
    console.error("Startup schema check failed:", error.message);
    return null;
  }
}
// Run once at startup, beside checkNumberSchema. Logins, ringing and history
// visibility read app_users and connection_numbers.personal (migration 014).
// Logs loudly and never throws: true when both exist, false when either is
// missing, null when the check itself could not run. Also warns when
// TWILIO_IDENTITY is unset: after cutover nothing mints the bootstrap token
// that used to set it, so the legacy ring fallback and sync of legacy calls
// would have no identity.
async function checkUsersSchema() {
  if (!process.env.TWILIO_IDENTITY)
    console.warn(
      "TWILIO_IDENTITY is not set. Production needs it: after cutover the legacy number's fallback ring (when the ring list can't be read) and the sync of legacy softphone calls have no identity without it.",
    );
  try {
    const result = await pool.query(
      `SELECT
        EXISTS (SELECT 1 FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_name = 'app_users') AS users_table,
        EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'connection_numbers'
            AND column_name = 'personal') AS personal_column`,
    );
    const row = result.rows[0] || {};
    if (row.users_table === true && row.personal_column === true) return true;
    console.error(
      "DATABASE NOT MIGRATED: run npm run migrate:users (migration 014). app_users or connection_numbers.personal is missing, so sign-in, ringing and history visibility fail.",
    );
    return false;
  } catch (error) {
    console.error("Startup users schema check failed:", error.message);
    return null;
  }
}
// `trustProxy` is the app's "trust proxy" setting (from TRUST_PROXY). Without
// it per-client sign-in limits are off (see src/security.js), so say so at
// startup.
function checkSignInLimits(trustProxy) {
  if (trustProxy) return true;
  console.warn(
    "Per-client sign-in limits are off: set TRUST_PROXY to the number of proxies in front of the app. Only the per-username cap applies.",
  );
  return false;
}
module.exports = {
  checkSignInLimits,
  checkUsersSchema,
  getProvider,
  getProviderForWebhook,
  legacyProvider,
  checkNumberSchema,
};
