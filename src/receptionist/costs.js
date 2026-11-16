/* What a call with the AI receptionist cost beyond Twilio's own call charge:
the Claude requests and the ConversationRelay minutes. Both are worked out
from list prices when the call ends and stored with it, so a later price
change does not rewrite the cost of past calls. They are estimates: the
invoices from Anthropic and Twilio are the real figures. */

// US dollars per million tokens, from Anthropic's pricing page (checked
// 2026-11-16). Fast mode doubles every figure; the cache prices scale with it.
const PRICES = {
  "claude-opus-5-5": {
    input: 4,
    cacheWrite5m: 5,
    cacheWrite1h: 8,
    cacheRead: 0.2,
    output: 20,
  },
  "claude-sonnet-5-5": {
    input: 2,
    cacheWrite5m: 2.5,
    cacheWrite1h: 4,
    cacheRead: 0.1,
    output: 10,
  },
  // For prompts up to 100,000 tokens, which is every prompt this app sends.
  "claude-haiku-5-5": {
    input: 0.1,
    cacheWrite5m: 0.125,
    cacheWrite1h: 0.2,
    cacheRead: 0.01,
    output: 0.5,
  },
};
const FAST_MULTIPLIER = 2;
const TOKEN_FIELDS = [
  "input",
  "cacheWrite5m",
  "cacheWrite1h",
  "cacheRead",
  "output",
];

const count = (value) => (Number.isFinite(value) && value > 0 ? value : 0);

// Adds one API response's token usage to `list`, which holds one entry per
// model and speed. A response with no usage adds nothing.
function addUsage(list, message) {
  const usage = message?.usage;
  if (!usage || typeof message.model !== "string") return list;
  const speed = usage.speed === "fast" ? "fast" : "standard";
  let entry = list.find(
    (item) => item.model === message.model && item.speed === speed,
  );
  if (!entry) {
    entry = { model: message.model, speed, requests: 0 };
    for (const field of TOKEN_FIELDS) entry[field] = 0;
    list.push(entry);
  }
  const written = count(usage.cache_creation_input_tokens);
  const fiveMinute = count(usage.cache_creation?.ephemeral_5m_input_tokens);
  // Without a breakdown, a cache write is counted as the one-hour kind: it is
  // the only kind this app asks for, and the dearer of the two.
  const oneHour = usage.cache_creation
    ? count(usage.cache_creation.ephemeral_1h_input_tokens)
    : written;
  entry.requests += 1;
  entry.input += count(usage.input_tokens);
  entry.cacheWrite5m += fiveMinute;
  entry.cacheWrite1h += oneHour;
  entry.cacheRead += count(usage.cache_read_input_tokens);
  entry.output += count(usage.output_tokens);
  return list;
}

// Dollars for a usage list, or null when it names a model with no known
// price: a wrong figure is worse than none.
function claudeCost(list) {
  let total = 0;
  for (const entry of list || []) {
    const prices = PRICES[entry.model];
    if (!prices) return null;
    const multiplier = entry.speed === "fast" ? FAST_MULTIPLIER : 1;
    for (const field of TOKEN_FIELDS)
      total += (count(entry[field]) * prices[field] * multiplier) / 1_000_000;
  }
  return total;
}

// Dollars for the ConversationRelay session, charged per started minute.
function relayCost(seconds, ratePerMinute) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.ceil(seconds / 60) * ratePerMinute;
}

module.exports = { PRICES, addUsage, claudeCost, relayCost };
