/* Settings for sending Jack's leads to Outreach. Read from the environment;
the sender runs only when OUTREACH_INTAKE_ENABLED is exactly "1" and the
endpoint, token, signing secret and workspace id are all set. Only calls
answered for OUTREACH_INTAKE_WORKSPACE_ID are ever queued for Outreach. */

const text = (value) => (value && value.trim() ? value.trim() : null);

function httpUrl(value) {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? raw : null;
  } catch {
    return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = (value) => {
  const raw = text(value)?.toLowerCase();
  return raw && UUID.test(raw) ? raw : null;
};

function getConfig(env = process.env) {
  return {
    enabled: env.OUTREACH_INTAKE_ENABLED === "1",
    url: httpUrl(env.OUTREACH_INTAKE_URL),
    token: text(env.OUTREACH_INTAKE_TOKEN),
    signingSecret: text(env.OUTREACH_INTAKE_SIGNING_SECRET),
    // The one workspace whose leads go to Outreach (receptionist_calls.workspace_id).
    workspaceId: uuid(env.OUTREACH_INTAKE_WORKSPACE_ID),
    // The app's public origin (the one Twilio's webhooks use), for the link
    // back to the lead card. APP_ORIGIN is only a development frontend.
    sourceBaseUrl: httpUrl(env.TWILIO_WEBHOOK_BASE_URL)?.replace(/\/+$/, ""),
  };
}

// True when the sender may run.
const isReady = (config) =>
  Boolean(
    config.enabled &&
      config.url &&
      config.token &&
      config.signingSecret &&
      config.workspaceId,
  );

// True when `row` belongs to the configured workspace. With no workspace
// configured nothing qualifies; that is logged once per process.
let warnedUnset = false;
function warnWorkspaceUnset() {
  if (warnedUnset) return;
  warnedUnset = true;
  console.error("Outreach intake:", "WORKSPACE_ID_UNSET");
}

function inWorkspace(row, config) {
  if (!config.workspaceId) {
    warnWorkspaceUnset();
    return false;
  }
  return Boolean(
    row && String(row.workspace_id || "").toLowerCase() === config.workspaceId,
  );
}

module.exports = { getConfig, isReady, inWorkspace, warnWorkspaceUnset };
