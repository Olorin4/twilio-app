/* Settings for the AI receptionist. Everything is read from the environment
so the feature can be switched off, or limited to test callers, without a
deploy. */

function integer(value, fallback, min, max) {
  const parsed = /^\d+$/.test(value || "") ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function decimal(value, fallback, min, max) {
  const parsed = /^\d+(\.\d+)?$/.test(value || "") ? Number(value) : NaN;
  return parsed >= min && parsed <= max ? parsed : fallback;
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

const text = (value) => (value && value.trim() ? value.trim() : null);

// A time zone the runtime does not know would make every hours check throw,
// which would fail every inbound call. Fall back instead.
function timeZone(value, fallback) {
  const zone = text(value);
  if (!zone) return fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return fallback;
  }
}

function getConfig(env = process.env) {
  return {
    enabled: env.RECEPTIONIST_ENABLED === "true",
    // Test mode stays on until it is explicitly turned off, so enabling the
    // feature can never put the agent in front of every caller by accident.
    testMode: env.RECEPTIONIST_TEST_MODE !== "false",
    testCallers: new Set(
      (env.RECEPTIONIST_TEST_CALLERS || "")
        .split(",")
        .map((number) => number.trim())
        .filter(Boolean),
    ),
    hours: {
      start: integer(env.RECEPTIONIST_HOURS_START, 7, 0, 23),
      end: integer(env.RECEPTIONIST_HOURS_END, 18, 1, 24),
      timeZone: timeZone(env.RECEPTIONIST_HOURS_TZ, "America/New_York"),
    },
    voice: text(env.RECEPTIONIST_VOICE) || "7EzWGsX10sAS4c9m9cPf",
    sayVoice: text(env.RECEPTIONIST_SAY_VOICE),
    liveModel: text(env.RECEPTIONIST_LIVE_MODEL) || "claude-opus-5-5",
    liveEffort: oneOf(
      env.RECEPTIONIST_LIVE_EFFORT,
      ["low", "medium", "high", "xhigh", "max"],
      "low",
    ),
    liveThinking: oneOf(
      env.RECEPTIONIST_LIVE_THINKING,
      ["default", "off"],
      "default",
    ),
    liveSpeed: oneOf(
      env.RECEPTIONIST_LIVE_SPEED,
      ["standard", "fast"],
      "standard",
    ),
    summaryModel: text(env.RECEPTIONIST_SUMMARY_MODEL) || "claude-opus-5-5",
    dailyLimit: integer(env.RECEPTIONIST_DAILY_LIMIT, 3, 1, 1000),
    maxCallSeconds: integer(env.RECEPTIONIST_MAX_CALL_SECONDS, 480, 30, 3600),
    // Twilio's list price per ConversationRelay minute, in US dollars. Used
    // only to estimate what a call cost.
    relayRate: decimal(env.RECEPTIONIST_RELAY_RATE, 0.07, 0, 10),
    alertEmail: text(env.RECEPTIONIST_ALERT_EMAIL),
    smtp: {
      host: text(env.SMTP_HOST),
      port: integer(env.SMTP_PORT, 587, 1, 65535),
      user: text(env.SMTP_USER),
      pass: text(env.SMTP_PASS),
      from: text(env.SMTP_FROM),
    },
  };
}

// True when `date` falls inside the calling hours, a half-open range
// [start, end) in the configured time zone.
function isOpen(date, hours) {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: hours.timeZone,
      hour: "numeric",
      hourCycle: "h23",
    }).format(date),
  );
  return hour >= hours.start && hour < hours.end;
}

// Options for the recorded <Say> announcements. The voice is opt-in: with
// none configured the TwiML is exactly what it was before the setting existed.
function sayOptions(env = process.env) {
  const voice = getConfig(env).sayVoice;
  return voice ? { voice } : {};
}

module.exports = { getConfig, isOpen, sayOptions };
