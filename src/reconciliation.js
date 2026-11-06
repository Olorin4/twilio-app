const { client, getIdentity } = require("./token");
const pool = require("./db");
const { saveLeg } = require("./callEvents");
const { saveStatus, numbers } = require("./conversations");
const { publish } = require("./messageEvents");
const { IRON_WING_WORKSPACE_ID } = require("./workspaceContext");
const { getProvider } = require("./providerContext");
const { ownsMessage, ownsRootCall } = require("./syncOwnership");

// Twilio's date filters can be day-granular. Revisit a full day of overlap and
// advance the checkpoint only after every page has been processed successfully.
async function syncStream(stream, api, save, options = {}) {
  const checkpoint = await pool.query(
    options.connectionId
      ? "SELECT synced_through FROM connection_sync_checkpoints WHERE stream = $1 AND connection_id = $2"
      : "SELECT synced_through FROM twilio_sync_checkpoints WHERE stream = $1",
    options.connectionId ? [stream, options.connectionId] : [stream],
  );
  if (!checkpoint.rows.length)
    throw new Error(`Missing ${stream} reconciliation checkpoint`);
  const started = new Date();
  const since = new Date(
    new Date(checkpoint.rows[0].synced_through).getTime() - 24 * 60 * 60 * 1000,
  );
  const listOptions =
    stream === "calls"
      ? { startTimeAfter: since, pageSize: 100 }
      : { dateSentAfter: since, pageSize: 100 };
  let page = await api.page(listOptions);
  let count = 0;
  while (page) {
    for (const item of page.instances) {
      await save(item);
      count++;
    }
    page = await page.nextPage();
  }
  if (options.beforeCheckpoint) await options.beforeCheckpoint();
  await pool.query(
    options.connectionId
      ? "UPDATE connection_sync_checkpoints SET synced_through = GREATEST(synced_through, $2::timestamptz) WHERE stream = $1 AND connection_id = $3"
      : "UPDATE twilio_sync_checkpoints SET synced_through = GREATEST(synced_through, $2::timestamptz) WHERE stream = $1",
    options.connectionId
      ? [stream, started, options.connectionId]
      : [stream, started],
  );
  return count;
}
async function saveCall(
  call,
  owner = { workspaceId: IRON_WING_WORKSPACE_ID, id: null },
) {
  if (call.parentCallSid) {
    await saveLeg(
      {
        sid: call.sid,
        parentSid: call.parentCallSid,
        status: call.status,
        duration: call.duration,
      },
      owner,
    );
  }
  await pool.query(
    `INSERT INTO call_logs (call_sid, timestamp, from_number, to_number, status, duration, direction, workspace_id, provider_connection_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (call_sid) DO UPDATE SET
      status = CASE WHEN call_logs.status IN ('completed', 'busy', 'failed', 'no-answer', 'canceled') AND EXCLUDED.status NOT IN ('completed', 'busy', 'failed', 'no-answer', 'canceled') THEN call_logs.status ELSE COALESCE(EXCLUDED.status, call_logs.status) END,
      duration = COALESCE(EXCLUDED.duration, call_logs.duration),
      direction = COALESCE(EXCLUDED.direction, call_logs.direction)
    WHERE call_logs.workspace_id = EXCLUDED.workspace_id AND call_logs.provider_connection_id IS NOT DISTINCT FROM EXCLUDED.provider_connection_id`,
    [
      call.sid,
      call.startTime || call.dateCreated,
      call.from,
      call.to,
      call.status,
      call.duration,
      call.direction,
      owner.workspaceId,
      owner.id || null,
    ],
  );
}
async function saveMessage(
  message,
  owner = { workspaceId: IRON_WING_WORKSPACE_ID, id: null },
) {
  const result = await pool.query(
    `INSERT INTO message_logs (message_sid, from_number, to_number, body, timestamp, workspace_id, provider_connection_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (message_sid) DO UPDATE SET message_sid = EXCLUDED.message_sid
    WHERE message_logs.workspace_id = EXCLUDED.workspace_id AND message_logs.provider_connection_id IS NOT DISTINCT FROM EXCLUDED.provider_connection_id RETURNING id`,
    [
      message.sid,
      message.from,
      message.to,
      message.body,
      message.dateSent || message.dateCreated,
      owner.workspaceId,
      owner.id || null,
    ],
  );
  if (
    result.rowCount &&
    message.direction &&
    message.direction.startsWith("outbound") &&
    message.status
  )
    await saveStatus(
      message.sid,
      message.status,
      message.errorCode,
      false,
      owner,
    );
}
const running = new Map();
async function callBelongsToOwner(sid, owner) {
  const result = await pool.query(
    `SELECT 1 FROM call_logs WHERE call_sid = $1 AND workspace_id = $2
    AND provider_connection_id IS NOT DISTINCT FROM $3::uuid`,
    [sid, owner.workspaceId, owner.id || null],
  );
  return result.rows.length > 0;
}
function reconcileOne(owner) {
  const key = owner.id || "legacy";
  if (!running.has(key)) {
    const work = (async () => {
      const ownedNumbers = owner.id
        ? (
            await pool.query(
              "SELECT phone_number FROM connection_numbers WHERE connection_id = $1",
              [owner.id],
            )
          ).rows.map((row) => row.phone_number)
        : numbers();
      const identity = owner.id
        ? `connection_${owner.id.replace(/-/g, "")}`
        : getIdentity();
      const pendingChildren = [];
      const checkpoint = owner.id ? { connectionId: owner.id } : {};
      const results = await Promise.allSettled([
        syncStream(
          "calls",
          owner.client.calls,
          async (call) => {
            if (call.parentCallSid) {
              pendingChildren.push(call);
              return;
            }
            if (
              ownsRootCall(call, ownedNumbers, identity) ||
              (await callBelongsToOwner(call.sid, owner))
            )
              await saveCall(call, owner);
          },
          {
            ...checkpoint,
            beforeCheckpoint: async () => {
              for (const call of pendingChildren)
                if (await callBelongsToOwner(call.parentCallSid, owner))
                  await saveCall(call, owner);
            },
          },
        ),
        syncStream(
          "messages",
          owner.client.messages,
          async (message) => {
            if (ownsMessage(message, ownedNumbers))
              await saveMessage(message, owner);
          },
          checkpoint,
        ),
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
      running.delete(key);
    });
    running.set(key, work);
  }
  return running.get(key);
}
function reconcile() {
  return reconcileOne({
    workspaceId: IRON_WING_WORKSPACE_ID,
    id: null,
    client,
  });
}
async function reconcileWorkspace(workspaceId) {
  const result = await pool.query(
    `SELECT DISTINCT ON (c.id) c.id, c.workspace_id, n.id AS number_id
    FROM provider_connections c JOIN connection_numbers n ON n.connection_id = c.id
    WHERE c.workspace_id = $1 ORDER BY c.id, n.id`,
    [workspaceId],
  );
  const tasks = result.rows.map(async (row) =>
    reconcileOne(await getProvider(workspaceId, row.number_id)),
  );
  if (workspaceId === IRON_WING_WORKSPACE_ID) tasks.push(reconcile());
  // A workspace without a connection has nothing to synchronize.
  if (!tasks.length) return 0;
  const results = await Promise.allSettled(tasks);
  if (results.some((entry) => entry.status === "rejected"))
    throw new Error("Twilio synchronization failed. Please try again.");
  return results.length;
}
async function reconcileAll() {
  const result = await pool.query("SELECT id FROM workspaces ORDER BY id");
  const results = await Promise.allSettled(
    result.rows.map((row) => reconcileWorkspace(row.id)),
  );
  if (results.some((entry) => entry.status === "rejected"))
    throw new Error("One or more workspace synchronizations failed.");
}
async function handleRequest(req, res) {
  try {
    await reconcileWorkspace(req.workspace?.id || IRON_WING_WORKSPACE_ID);
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
  reconcileAll,
  reconcileWorkspace,
  reconcileOne,
};
