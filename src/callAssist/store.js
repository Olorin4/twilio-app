const pool = require("../db");
const {
  config,
  eligible,
  uuid,
  callSid,
  transcriptionSid,
  normalize,
} = require("./config");

async function bindIntent(body, provider) {
  if (!uuid.test(body.AssistIntent || "") || !callSid.test(body.CallSid || ""))
    return;
  const identity = provider.legacy
    ? require("../token").getIdentity()
    : `connection_${provider.id.replace(/-/g, "")}`;
  if (
    !identity ||
    body.From !== `client:${identity}` ||
    body.AccountSid !== provider.accountSid
  )
    return;
  const destination = normalize(body.To);
  await pool.query(
    `UPDATE phone_call_sessions SET call_sid = $2, assist = assist AND $8,
       updated_at = now()
     WHERE id = $1 AND workspace_id = $3 AND provider_connection_id IS NOT DISTINCT FROM $4::uuid
       AND account_sid = $5 AND destination = $6 AND from_number = $7
       AND call_sid IS NULL AND created_at > now() - interval '2 minutes'`,
    [
      body.AssistIntent,
      body.CallSid,
      provider.workspaceId,
      provider.id || null,
      provider.accountSid,
      destination,
      provider.phoneNumber,
      eligible(config(), {
        workspace: provider.workspaceId,
        connection: provider.id,
        number: provider.phoneNumber,
        destination,
      }),
    ],
  );
}

async function ingest(req, res) {
  const body = req.body;
  const owner = req.providerConnection;
  if (
    !uuid.test(req.params.sessionId) ||
    !transcriptionSid.test(body.TranscriptionSid || "") ||
    !callSid.test(body.CallSid || "")
  )
    return res.sendStatus(400);
  const event = body.TranscriptionEvent;
  const terminal =
    event === "transcription-stopped" || event === "transcription-error";
  const content = event === "transcription-content";
  if (!terminal && !content && event !== "transcription-started")
    return res.sendStatus(204);
  let utterance;
  let speaker;
  if (content) {
    try {
      utterance = JSON.parse(body.TranscriptionData);
    } catch {
      return res.sendStatus(400);
    }
    if (body.Final !== "true") return res.sendStatus(204);
    speaker = { inbound_track: "Dispatcher", outbound_track: "Caller" }[
      body.Track
    ];
    if (
      !speaker ||
      !/^\d{1,9}$/.test(body.SequenceId || "") ||
      typeof utterance?.transcript !== "string"
    )
      return res.sendStatus(400);
    if (!utterance.transcript.trim()) return res.sendStatus(204);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const {
      rows: [row],
    } = await client.query(
      `SELECT * FROM phone_call_sessions WHERE id = $1 AND call_sid = $2
       AND workspace_id = $3 AND provider_connection_id = $4 AND account_sid = $5
       AND assist AND capture_started_at IS NOT NULL
       AND (transcription_sid IS NULL OR transcription_sid = $6) FOR UPDATE`,
      [
        req.params.sessionId,
        body.CallSid,
        owner.workspaceId,
        owner.id,
        owner.accountSid,
        body.TranscriptionSid,
      ],
    );
    if (!row) {
      await client.query("ROLLBACK");
      return res.sendStatus(204);
    }
    const allowed = eligible(config(), {
      workspace: row.workspace_id,
      connection: row.provider_connection_id,
      number: row.from_number,
      destination: row.destination,
    });
    if (content && allowed) {
      const inserted = await client.query(
        `INSERT INTO phone_call_utterances (session_id, sequence_id, speaker, content)
         SELECT $1, $2, $3, $4 FROM phone_call_sessions
         WHERE id = $1 AND (capture_ended_at IS NULL OR capture_ended_at > now() - interval '8 seconds')
         AND summary_state = 'none'
         ON CONFLICT DO NOTHING`,
        [
          row.id,
          Number(body.SequenceId),
          speaker,
          utterance.transcript.trim().slice(0, 4000),
        ],
      );
      if (inserted.rowCount && speaker === "Caller" && !row.capture_ended_at) {
        await client.query(
          `UPDATE phone_call_sessions SET next_suggestion_at = COALESCE(next_suggestion_at, now() + interval '500 milliseconds')
           WHERE id = $1`,
          [row.id],
        );
      }
    }
    await client.query(
      `UPDATE phone_call_sessions SET transcription_sid = $2,
        capture_state = CASE WHEN $3 THEN $4 WHEN capture_ended_at IS NOT NULL THEN capture_state ELSE 'listening' END,
        capture_ended_at = CASE WHEN $3 THEN COALESCE(capture_ended_at, now()) ELSE capture_ended_at END,
        stop_confirmed = stop_confirmed OR $5,
        partial = partial OR $6, updated_at = now()
       WHERE id = $1`,
      [
        row.id,
        body.TranscriptionSid,
        terminal,
        event === "transcription-error" ? "unavailable" : "stopped",
        event === "transcription-stopped",
        event === "transcription-error",
      ],
    );
    await client.query("COMMIT");
    return res.sendStatus(204);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { bindIntent, ingest };
