const twilio = require("twilio");
const pool = require("./db");
const { decryptCredentials } = require("./credentialEncryption");

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A Twilio connection's identifiers and auth token, or null when the id is
// malformed or unknown. Throws when the lookup or decryption fails.
async function loadConnectionAuth(connectionId) {
  if (!uuidPattern.test(connectionId || "")) return null;
  const result = await pool.query(
    `SELECT c.id, c.workspace_id, c.account_sid, c.encrypted_credentials
      FROM provider_connections c JOIN workspaces w ON w.id = c.workspace_id
      WHERE c.id = $1 AND c.provider = 'twilio' AND w.archived_at IS NULL`,
    [connectionId],
  );
  if (!result.rows.length) return null;
  const connection = result.rows[0];
  const credentials = decryptCredentials(
    connection.id,
    connection.encrypted_credentials,
  );
  return {
    id: connection.id,
    workspaceId: connection.workspace_id,
    accountSid: connection.account_sid,
    authToken: credentials.authToken,
  };
}

// The connection id comes from the public webhook path, not the browser's
// selected workspace. It identifies a candidate only; authentication still
// requires the matching account and a valid Twilio signature.
async function authenticateConnectionWebhook(req, res, next) {
  const connectionId = req.params.connectionId;
  if (!uuidPattern.test(connectionId || "")) return res.sendStatus(403);
  const baseUrl = process.env.TWILIO_WEBHOOK_BASE_URL;
  if (!baseUrl) return res.sendStatus(503);
  try {
    const connection = await loadConnectionAuth(connectionId);
    if (!connection) return res.sendStatus(403);
    if (req.body?.AccountSid !== connection.accountSid)
      return res.sendStatus(403);
    const signature = req.get("X-Twilio-Signature") || "";
    const url = baseUrl.replace(/\/$/, "") + req.originalUrl;
    if (!twilio.validateRequest(connection.authToken, signature, url, req.body))
      return res.sendStatus(403);
    // Do not attach credentials to req: handlers need only identifiers.
    req.providerConnection = {
      id: connection.id,
      workspaceId: connection.workspaceId,
      accountSid: connection.accountSid,
    };
    return next();
  } catch (error) {
    console.error(
      "Connection webhook authentication failed:",
      error.code || "configuration error",
    );
    return res.sendStatus(503);
  }
}
module.exports = { authenticateConnectionWebhook, loadConnectionAuth };
