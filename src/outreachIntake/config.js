/* Settings for sending Jack's leads to Outreach. Read from the environment;
the sender runs only when OUTREACH_INTAKE_ENABLED is exactly "1" and the
endpoint, token and signing secret are all set. */

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

function getConfig(env = process.env) {
  return {
    enabled: env.OUTREACH_INTAKE_ENABLED === "1",
    url: httpUrl(env.OUTREACH_INTAKE_URL),
    token: text(env.OUTREACH_INTAKE_TOKEN),
    signingSecret: text(env.OUTREACH_INTAKE_SIGNING_SECRET),
    // The app's public origin (the one Twilio's webhooks use), for the link
    // back to the lead card. APP_ORIGIN is only a development frontend.
    sourceBaseUrl: httpUrl(env.TWILIO_WEBHOOK_BASE_URL)?.replace(/\/+$/, ""),
  };
}

// True when the sender may run.
const isReady = (config) =>
  Boolean(config.enabled && config.url && config.token && config.signingSecret);

module.exports = { getConfig, isReady };
