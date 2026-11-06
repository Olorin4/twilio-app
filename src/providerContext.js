const twilio = require("twilio");
const pool = require("./db");
const { decryptCredentials } = require("./credentialEncryption");
const { IRON_WING_WORKSPACE_ID } = require("./workspaceContext");
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
      n.id AS number_id, n.phone_number, n.voice_enabled, n.sms_enabled
    FROM workspace_active_numbers a JOIN connection_numbers n ON n.id = COALESCE($2::uuid, a.connection_number_id)
      JOIN provider_connections c ON c.id = n.connection_id
    WHERE a.workspace_id = $1 AND c.workspace_id = $1
    UNION ALL
    SELECT c.id, c.workspace_id, c.account_sid, c.encrypted_credentials,
      n.id AS number_id, n.phone_number, n.voice_enabled, n.sms_enabled
    FROM connection_numbers n JOIN provider_connections c ON c.id = n.connection_id
    WHERE $2::uuid IS NOT NULL AND n.id = $2 AND c.workspace_id = $1
      AND NOT EXISTS (SELECT 1 FROM workspace_active_numbers a WHERE a.workspace_id = $1)
    LIMIT 1`,
    [workspaceId, requestedNumberId || null],
  );
  if (!result.rows.length) {
    if (workspaceId === IRON_WING_WORKSPACE_ID && !requestedNumberId) {
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
module.exports = { getProvider, getProviderForWebhook, legacyProvider };
