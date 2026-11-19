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
    baseUrl: env.TWILIO_WEBHOOK_BASE_URL?.replace(/\/$/, ""),
    model: env.CALL_ASSIST_MODEL || "claude-haiku-5-5",
    summaryModel:
      env.CALL_ASSIST_SUMMARY_MODEL ||
      env.RECEPTIONIST_SUMMARY_MODEL ||
      "claude-opus-5-5",
    maxSeconds: numberSetting(env.CALL_ASSIST_MAX_SECONDS, 600, 30, 1800),
    maxSuggestions: numberSetting(env.CALL_ASSIST_MAX_SUGGESTIONS, 30, 1, 100),
    retainTranscript: env.CALL_ASSIST_RETAIN_TRANSCRIPT === "true",
  };
}

function available(settings) {
  return settings.enabled && /^https:\/\//.test(settings.baseUrl || "");
}

function eligible(settings, { number, destination }) {
  return (
    available(settings) &&
    e164.test(number || "") &&
    e164.test(destination || "")
  );
}

module.exports = {
  config,
  available,
  eligible,
  uuid,
  callSid,
  transcriptionSid,
  normalize,
  e164,
};
