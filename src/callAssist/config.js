const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const callSid = /^CA[0-9a-f]{32}$/i;
const transcriptionSid = /^GT[0-9a-f]{32}$/i;
const e164 = /^\+[1-9]\d{7,14}$/;
const normalize = (value) => String(value ?? "").replace(/[\s().-]/g, "");

function numberSetting(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max
    ? number
    : fallback;
}

function config(env = process.env) {
  return {
    enabled: env.CALL_ASSIST_ENABLED === "true",
    workspace: env.CALL_ASSIST_WORKSPACE_ID?.toLowerCase(),
    connection: env.CALL_ASSIST_CONNECTION_ID?.toLowerCase(),
    number: env.CALL_ASSIST_NUMBER,
    destinations: new Set(
      (env.CALL_ASSIST_DESTINATIONS || "")
        .split(",")
        .map(normalize)
        .filter((value) => e164.test(value)),
    ),
    baseUrl: env.TWILIO_WEBHOOK_BASE_URL?.replace(/\/$/, ""),
    model:
      env.CALL_ASSIST_MODEL || env.RECEPTIONIST_LIVE_MODEL || "claude-opus-5-5",
    summaryModel:
      env.CALL_ASSIST_SUMMARY_MODEL ||
      env.RECEPTIONIST_SUMMARY_MODEL ||
      "claude-opus-5-5",
    maxSeconds: numberSetting(env.CALL_ASSIST_MAX_SECONDS, 600, 30, 1800),
    maxSuggestions: numberSetting(env.CALL_ASSIST_MAX_SUGGESTIONS, 30, 1, 100),
    retainTranscript: env.CALL_ASSIST_RETAIN_TRANSCRIPT === "true",
  };
}

function eligible(settings, { workspace, connection, number, destination }) {
  return (
    settings.enabled &&
    /^https:\/\//.test(settings.baseUrl || "") &&
    uuid.test(settings.workspace || "") &&
    uuid.test(settings.connection || "") &&
    e164.test(settings.number || "") &&
    settings.workspace === workspace &&
    settings.connection === connection &&
    settings.number === number &&
    settings.destinations.has(destination)
  );
}

module.exports = {
  config,
  eligible,
  uuid,
  callSid,
  transcriptionSid,
  normalize,
  e164,
};
