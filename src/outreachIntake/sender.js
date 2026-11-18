/* Sends queued jack.call.v1 events to Outreach.

Each run claims due PENDING rows (FOR UPDATE SKIP LOCKED, then a short lease
on next_attempt_at so another process skips them while the request is in
flight), POSTs each one signed, and records the result. Only safe error codes
are stored: never a response body, a header or a secret. */

const crypto = require("crypto");
const { getConfig, isReady } = require("./config");
const { jackCallV1 } = require("./contract");

const TIMEOUT_MS = 10 * 1000;
const INTERVAL_MS = 30 * 1000;
const BATCH = 20;
const MAX_ATTEMPTS = 12;
const LEASE = "2 minutes";
// Wait before the next try, by the number of failed attempts so far.
const BACKOFF_SECONDS = [60, 5 * 60, 30 * 60, 2 * 60 * 60, 6 * 60 * 60];

// 401/403/404 usually mean a rotated token or a route not deployed yet on
// Outreach's side: worth retrying, but slowly (15 min, doubling, up to 6 h).
const SLOW_STATUSES = [401, 403, 404];
const SLOW_FIRST_SECONDS = 15 * 60;
const SLOW_MAX_SECONDS = 6 * 60 * 60;

const backoffSeconds = (attempts) =>
  BACKOFF_SECONDS[Math.min(Math.max(attempts, 1), BACKOFF_SECONDS.length) - 1];
const slowBackoffSeconds = (attempts) =>
  Math.min(
    SLOW_FIRST_SECONDS * 2 ** Math.min(Math.max(attempts, 1) - 1, 10),
    SLOW_MAX_SECONDS,
  );

// X-IW-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + body)>
function sign(secret, rawBody, unixSeconds) {
  const digest = crypto
    .createHmac("sha256", secret)
    .update(`${unixSeconds}.${rawBody}`)
    .digest("hex");
  return `t=${unixSeconds},v1=${digest}`;
}

// What to do after one attempt: { result: "delivered" | "retry" | "failed",
// code, slow? }. `slow` asks for the long backoff.
function classify({ status, error }) {
  if (error) {
    if (error.name === "AbortError" || error.name === "TimeoutError")
      return { result: "retry", code: "TIMEOUT" };
    return { result: "retry", code: "NETWORK" };
  }
  if (status >= 200 && status < 300) return { result: "delivered", code: null };
  if (status === 408 || status === 429 || status >= 500)
    return { result: "retry", code: `HTTP_${status}` };
  if (SLOW_STATUSES.includes(status))
    return { result: "retry", code: `HTTP_${status}`, slow: true };
  if (status >= 400) return { result: "failed", code: `HTTP_${status}` };
  // 1xx/3xx should not reach here (redirects are refused); try again later.
  return { result: "retry", code: `HTTP_${status}` };
}

async function claim(db) {
  const result = await db.query(
    `UPDATE outreach_outbox SET next_attempt_at = now() + interval '${LEASE}'
     WHERE id IN (
       SELECT id FROM outreach_outbox
       WHERE status = 'PENDING' AND next_attempt_at <= now()
       ORDER BY next_attempt_at, id
       LIMIT $1
       FOR UPDATE SKIP LOCKED)
     RETURNING id, event_id, payload, attempts`,
    [BATCH],
  );
  return [...result.rows].sort((a, b) => Number(a.id) - Number(b.id));
}

async function record(db, row, outcome) {
  const attempts = row.attempts + 1;
  if (outcome.result === "delivered") {
    await db.query(
      `UPDATE outreach_outbox SET status = 'DELIVERED', attempts = $2,
         delivered_at = now(), last_error_code = NULL
       WHERE id = $1`,
      [row.id, attempts],
    );
    return "delivered";
  }
  if (outcome.result === "failed" || attempts >= MAX_ATTEMPTS) {
    await db.query(
      `UPDATE outreach_outbox SET status = 'FAILED', attempts = $2,
         last_error_code = $3
       WHERE id = $1`,
      [row.id, attempts, outcome.code],
    );
    return "failed";
  }
  await db.query(
    `UPDATE outreach_outbox SET attempts = $2, last_error_code = $3,
       next_attempt_at = now() + make_interval(secs => $4)
     WHERE id = $1`,
    [
      row.id,
      attempts,
      outcome.code,
      outcome.slow ? slowBackoffSeconds(attempts) : backoffSeconds(attempts),
    ],
  );
  return "retry";
}

async function post(row, { config, fetch, now }) {
  const rawBody = JSON.stringify(row.payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.token}`,
        "X-IW-Signature": sign(
          config.signingSecret,
          rawBody,
          Math.floor(now() / 1000),
        ),
      },
      body: rawBody,
      redirect: "error",
      signal: controller.signal,
    });
    // The body is never read or stored; release the connection.
    try {
      await response.body?.cancel?.();
    } catch {
      // ignore
    }
    return classify({ status: response.status });
  } catch (error) {
    return classify({ error });
  } finally {
    clearTimeout(timer);
  }
}

// Sends every due event once. Returns counts only.
async function runOnce(deps = {}) {
  const {
    db = require("../db"),
    fetch = globalThis.fetch,
    config = getConfig(),
    now = Date.now,
  } = deps;
  const counts = { delivered: 0, retry: 0, failed: 0 };
  if (!isReady(config)) return counts;
  for (const row of await claim(db)) {
    const valid = jackCallV1.safeParse(row.payload).success;
    const outcome = valid
      ? await post(row, { config, fetch, now })
      : { result: "failed", code: "INVALID_PAYLOAD" };
    counts[await record(db, row, outcome)] += 1;
  }
  return counts;
}

// Starts the 30-second loop when the feature is switched on and fully
// configured. Returns the timer, or null when the sender stays off.
function start(deps = {}) {
  const { config = getConfig(), setInterval: every = setInterval } = deps;
  if (!isReady(config)) return null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const counts = await runOnce({ ...deps, config });
      if (counts.delivered || counts.retry || counts.failed)
        console.log("Outreach intake:", JSON.stringify(counts));
    } catch (error) {
      console.error("Outreach intake run failed:", error.code || error.name);
    } finally {
      running = false;
    }
  };
  const timer = every(tick, INTERVAL_MS);
  timer?.unref?.();
  return timer;
}

module.exports = {
  MAX_ATTEMPTS,
  TIMEOUT_MS,
  INTERVAL_MS,
  backoffSeconds,
  slowBackoffSeconds,
  sign,
  classify,
  runOnce,
  start,
};
