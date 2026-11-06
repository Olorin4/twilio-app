const twilio = require("twilio");
const pool = require("./db");
const { decryptCredentials } = require("./credentialEncryption");

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The connection id comes from the public webhook path, not the browser's
// selected workspace. It identifies a candidate only; authentication still
// requires the matching account and a valid Twilio signature.
async function authenticateConnectionWebhook(req, res, next) {
  const connectionId = req.params.connectionId;
  if (!uuidPattern.test(connectionId || "")) return res.sendStatus(403);
  const baseUrl = process.env.TWILIO_WEBHOOK_BASE_URL;
  if (!baseUrl) return res.sendStatus(503);
  try {
    const result = await pool.query(
      `SELECT id, workspace_id, account_sid, encrypted_credentials
      FROM provider_connections WHERE id = $1 AND provider = 'twilio'`,
      [connectionId],
    );
    if (!result.rows.length) return res.sendStatus(403);
    const connection = result.rows[0];
    if (req.body?.AccountSid !== connection.account_sid)
      return res.sendStatus(403);
    const credentials = decryptCredentials(
      connection.id,
      connection.encrypted_credentials,
    );
    const signature = req.get("X-Twilio-Signature") || "";
    const url = baseUrl.replace(/\/$/, "") + req.originalUrl;
    if (
      !twilio.validateRequest(credentials.authToken, signature, url, req.body)
    )
      return res.sendStatus(403);
    // Do not attach credentials to req: handlers need only identifiers.
    req.providerConnection = {
      id: connection.id,
      workspaceId: connection.workspace_id,
      accountSid: connection.account_sid,
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
module.exports = { authenticateConnectionWebhook };
