const { client } = require("./token");
const pool = require("./db");
const { saveLeg } = require("./callEvents");
const { saveStatus } = require("./conversations");
const { publish } = require("./messageEvents");

// Twilio's date filters can be day-granular. Revisit a full day of overlap and
// advance the checkpoint only after every page has been processed successfully.
async function syncStream(stream, api, save) {
  const checkpoint = await pool.query(
    "SELECT synced_through FROM twilio_sync_checkpoints WHERE stream = $1",
    [stream],
  );
  if (!checkpoint.rows.length)
    throw new Error(`Missing ${stream} reconciliation checkpoint`);
  const started = new Date();
  const since = new Date(
    new Date(checkpoint.rows[0].synced_through).getTime() - 24 * 60 * 60 * 1000,
  );
  const options =
    stream === "calls"
      ? { startTimeAfter: since, pageSize: 100 }
      : { dateSentAfter: since, pageSize: 100 };
  let page = await api.page(options);
  let count = 0;
  while (page) {
    for (const item of page.instances) {
      await save(item);
      count++;
    }
    page = await page.nextPage();
  }
  await pool.query(
    "UPDATE twilio_sync_checkpoints SET synced_through = GREATEST(synced_through, $2::timestamptz) WHERE stream = $1",
    [stream, started],
  );
  return count;
}
async function saveCall(call) {
  if (call.parentCallSid) {
    await saveLeg({
      sid: call.sid,
      parentSid: call.parentCallSid,
      status: call.status,
      duration: call.duration,
    });
  }
  await pool.query(
    `INSERT INTO call_logs (call_sid, timestamp, from_number, to_number, status, duration, direction)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (call_sid) DO UPDATE SET
      status = CASE WHEN call_logs.status IN ('completed', 'busy', 'failed', 'no-answer', 'canceled') AND EXCLUDED.status NOT IN ('completed', 'busy', 'failed', 'no-answer', 'canceled') THEN call_logs.status ELSE COALESCE(EXCLUDED.status, call_logs.status) END,
      duration = COALESCE(EXCLUDED.duration, call_logs.duration),
      direction = COALESCE(EXCLUDED.direction, call_logs.direction)`,
    [
      call.sid,
      call.startTime || call.dateCreated,
      call.from,
      call.to,
      call.status,
      call.duration,
      call.direction,
    ],
  );
}
async function saveMessage(message) {
  await pool.query(
    `INSERT INTO message_logs (message_sid, from_number, to_number, body, timestamp)
    VALUES ($1, $2, $3, $4, $5) ON CONFLICT (message_sid) DO NOTHING`,
    [
      message.sid,
      message.from,
      message.to,
      message.body,
      message.dateSent || message.dateCreated,
    ],
  );
  if (
    message.direction &&
    message.direction.startsWith("outbound") &&
    message.status
  )
    await saveStatus(message.sid, message.status, message.errorCode, false);
}
let inFlight;
function reconcile() {
  if (!inFlight) {
    inFlight = (async () => {
      const results = await Promise.allSettled([
        syncStream("calls", client.calls, saveCall),
        syncStream("messages", client.messages, saveMessage),
      ]);
      publish();
      const errors = results.filter((result) => result.status === "rejected");
      if (errors.length) {
        for (const error of errors)
          console.error(
            "Twilio reconciliation stream failed:",
            error.reason.message,
          );
        throw new Error("Twilio synchronization failed. Please try again.");
      }
      return { calls: results[0].value, messages: results[1].value };
    })().finally(() => {
      inFlight = undefined;
    });
  }
  return inFlight;
}
async function handleRequest(req, res) {
  try {
    await reconcile();
    res.json({ ok: true });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
}
module.exports = {
  reconcile,
  handleRequest,
  syncStream,
  saveCall,
  saveMessage,
};
