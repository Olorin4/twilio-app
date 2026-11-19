const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const twilio = require("twilio");
const pool = require("../db");
const { loadConnectionAuth } = require("../connectionWebhooks");
const { legacyProvider } = require("../providerContext");
const { publish } = require("../messageEvents");
const { config, eligible } = require("./config");
const { analyze } = require("./model");
const { events, clearCaptions } = require("./live");

const terminal = ["completed", "busy", "failed", "no-answer", "canceled"];
const canCapture = (settings, row) =>
  eligible(settings, {
    number: row.from_number,
    destination: row.destination,
  });

async function transcription(row) {
  const connection = row.provider_connection_id
    ? await loadConnectionAuth(row.provider_connection_id)
    : legacyProvider(row.workspace_id);
  if (
    connection?.workspaceId !== row.workspace_id ||
    connection.accountSid !== row.account_sid
  )
    throw new Error("Call connection unavailable");
  const client = twilio(connection.accountSid, connection.authToken, {
    timeout: 5000,
  });
  return client.calls(row.call_sid).transcriptions;
}

async function startCapture(row, settings) {
  const claim = await pool.query(
    `UPDATE phone_call_sessions SET capture_started_at = now(),
      capture_lease_until = now() + interval '15 seconds', updated_at = now()
     WHERE id = $1 AND capture_started_at IS NULL AND capture_ended_at IS NULL
       AND NOT stop_requested
       AND NOT EXISTS (SELECT 1 FROM twilio_call_legs
         WHERE parent_call_sid = $2 AND workspace_id = $3
           AND provider_connection_id IS NOT DISTINCT FROM $4::uuid AND status = ANY($5))
     RETURNING id`,
    [
      row.id,
      row.call_sid,
      row.workspace_id,
      row.provider_connection_id,
      terminal,
    ],
  );
  if (!claim.rowCount) return;
  try {
    const list = await transcription(row);
    if (!canCapture(config(), row)) return;
    const prefix = row.provider_connection_id
      ? `/webhooks/${row.provider_connection_id}`
      : "";
    const options = {
      name: row.id,
      track: "both_tracks",
      partialResults: true,
      inboundTrackLabel: "Dispatcher",
      outboundTrackLabel: "Caller",
      statusCallbackUrl: `${settings.baseUrl}${prefix}/transcription/${row.id}`,
    };
    let started;
    try {
      started = await list.create(options);
    } catch (error) {
      if (Number(error.code) !== 21220) throw error;
      await delay(500);
      const { rowCount } = await pool.query(
        `SELECT 1 FROM phone_call_sessions s WHERE id = $1
          AND capture_ended_at IS NULL AND transcription_sid IS NULL AND NOT stop_requested
          AND NOT EXISTS (SELECT 1 FROM twilio_call_legs l
            WHERE l.parent_call_sid = s.call_sid AND l.workspace_id = s.workspace_id
              AND l.provider_connection_id IS NOT DISTINCT FROM s.provider_connection_id AND l.status = ANY($2))`,
        [row.id, terminal],
      );
      if (!rowCount || !canCapture(config(), row)) return;
      started = await list.create(options);
    }
    await pool.query(
      `UPDATE phone_call_sessions SET transcription_sid = COALESCE(transcription_sid, $2),
         capture_state = CASE WHEN capture_ended_at IS NULL THEN 'listening' ELSE capture_state END,
         updated_at = now() WHERE id = $1`,
      [row.id, started.sid],
    );
  } catch (error) {
    // A definite rejection can be reflected now. Wait for the signed
    // callback on an ambiguous result and never send a second create.
    if (error.status >= 400 && error.status < 500) {
      await pool.query(
        `UPDATE phone_call_sessions SET capture_state = 'unavailable',
           capture_ended_at = now(), updated_at = now()
         WHERE id = $1 AND transcription_sid IS NULL`,
        [row.id],
      );
    }
    console.error(
      "Call assist could not start:",
      error.code || "provider unavailable",
    );
  }
}

async function stopCapture(row) {
  if (row.stop_confirmed || !row.capture_started_at) return;
  const claim = await pool.query(
    `UPDATE phone_call_sessions SET stop_lease_until = now() + interval '10 seconds'
     WHERE id = $1 AND NOT stop_confirmed AND COALESCE(stop_lease_until, '-infinity') <= now()
     RETURNING id`,
    [row.id],
  );
  if (!claim.rowCount) return;
  try {
    const list = await transcription(row);
    await list(row.transcription_sid || row.id).update({ status: "stopped" });
    await pool.query(
      "UPDATE phone_call_sessions SET stop_confirmed = true WHERE id = $1",
      [row.id],
    );
  } catch (error) {
    if (error.status === 404 && (row.ended_at || row.transcription_sid)) {
      await pool.query(
        "UPDATE phone_call_sessions SET stop_confirmed = true WHERE id = $1",
        [row.id],
      );
    } else {
      console.error(
        "Call assist could not stop:",
        error.code || "provider unavailable",
      );
    }
  }
}

async function processCapture(row, settings) {
  const ended = terminal.includes(row.leg_status);
  const disabled = !canCapture(settings, row);
  const expired =
    row.capture_started_at &&
    Date.now() - row.capture_started_at.getTime() >= settings.maxSeconds * 1000;
  const unansweredTimeout =
    !row.capture_started_at && Date.now() - row.created_at.getTime() > 120000;
  const lostStart =
    row.capture_started_at &&
    !row.transcription_sid &&
    row.capture_lease_until?.getTime() <= Date.now();
  if (
    ended ||
    disabled ||
    row.stop_requested ||
    expired ||
    unansweredTimeout ||
    lostStart
  ) {
    if ((ended && !row.ended_at) || !row.capture_ended_at) {
      await pool.query(
        `UPDATE phone_call_sessions SET
          capture_state = CASE WHEN capture_ended_at IS NOT NULL THEN capture_state
            WHEN $3 THEN 'unavailable' ELSE 'stopped' END,
          ended_at = CASE WHEN $2 THEN COALESCE(ended_at, now()) ELSE ended_at END,
          capture_ended_at = COALESCE(capture_ended_at, now()),
          partial = partial OR (capture_started_at IS NOT NULL AND $4),
          stop_confirmed = stop_confirmed OR $2,
          updated_at = now()
         WHERE id = $1`,
        [
          row.id,
          ended,
          Boolean(disabled || lostStart || unansweredTimeout),
          Boolean(!ended || row.leg_status !== "completed"),
        ],
      );
    }
    clearCaptions(row.id);
    if (!ended) await stopCapture(row);
    return;
  }
  if (!row.capture_started_at && row.leg_status === "in-progress")
    await startCapture(row, settings);
}

async function runModel(row, settings, kind) {
  const summary = kind === "summary";
  if (summary && row.summary_attempts >= 3) {
    await pool.query(
      `UPDATE phone_call_sessions SET summary_state = 'unavailable', updated_at = now()
       WHERE id = $1 AND summary_state = 'pending' AND summary_attempts >= 3
        AND COALESCE(model_lease_until, '-infinity') <= now()`,
      [row.id],
    );
    return;
  }
  const lease = randomUUID();
  const condition = summary
    ? "capture_ended_at <= now() - interval '8 seconds' AND summary_state IN ('none', 'pending') AND summary_attempts < 3 AND COALESCE(summary_at, '-infinity') <= now()"
    : "capture_ended_at IS NULL AND NOT stop_requested AND next_suggestion_at <= now() AND COALESCE(last_suggestion_at, '-infinity') <= now() - interval '1500 milliseconds' AND suggestion_count < $3";
  const values = summary
    ? [row.id, lease]
    : [row.id, lease, settings.maxSuggestions];
  const claimed = await pool.query(
    `UPDATE phone_call_sessions SET model_lease_until = now() + interval '30 seconds',
      model_lease_id = $2, ${summary ? "summary_state = 'pending', summary_attempts = summary_attempts + 1" : "suggestion_count = suggestion_count + 1, next_suggestion_at = NULL, last_suggestion_at = now()"},
      updated_at = now()
     WHERE id = $1 AND COALESCE(model_lease_until, '-infinity') <= now() AND ${condition}
     RETURNING *`,
    values,
  );
  if (!claimed.rowCount) return;
  const session = claimed.rows[0];
  const { rows: turns } = await pool.query(
    `SELECT sequence_id, speaker, content, received_at FROM phone_call_utterances
     WHERE session_id = $1 ORDER BY sequence_id DESC LIMIT $2`,
    [row.id, summary ? 180 : 8],
  );
  const latestCaller = turns.find((turn) => turn.speaker === "Caller");
  let earlyCue;
  function measure(generatedAt) {
    return latestCaller && modelStartedAt
      ? {
          latencyMs: generatedAt - latestCaller.received_at.getTime(),
          queueMs: Math.max(
            0,
            modelStartedAt - latestCaller.received_at.getTime(),
          ),
          modelMs: generatedAt - modelStartedAt,
          generatedAt,
        }
      : { generatedAt };
  }
  function logTiming({ latencyMs, queueMs, modelMs }) {
    console.info(
      "Call assist suggestion timing:",
      JSON.stringify({ latencyMs, queueMs, modelMs }),
    );
  }
  async function publishCue(value) {
    const line = value.trim().slice(0, 500);
    if (
      !line ||
      !canCapture(config(), session) ||
      line.toLowerCase() === session.suggestion?.line?.toLowerCase()
    )
      return;
    const cue = { line, ...measure(Date.now()) };
    const saved = await pool.query(
      `UPDATE phone_call_sessions SET suggestion = $3, suggestion_failed = false, updated_at = now()
       WHERE id = $1 AND model_lease_id = $2 AND capture_ended_at IS NULL AND NOT stop_requested
         AND NOT EXISTS (SELECT 1 FROM phone_call_utterances WHERE session_id = $1
           AND speaker = 'Caller' AND sequence_id > $4)`,
      [row.id, lease, JSON.stringify(cue), latestCaller?.sequence_id ?? -1],
    );
    if (!saved.rowCount) return;
    earlyCue = cue;
    logTiming(cue);
    events.emit(row.id);
  }
  let result;
  let modelStartedAt;
  let failed = false;
  try {
    if (turns.length && canCapture(config(), session)) {
      const lead =
        session.lead_sid &&
        (
          await pool.query(
            `SELECT summary, script, details FROM receptionist_calls WHERE call_sid = $1 AND workspace_id = $2`,
            [session.lead_sid, session.workspace_id],
          )
        ).rows[0];
      modelStartedAt = Date.now();
      result = await analyze({
        model: summary ? settings.summaryModel : settings.model,
        kind,
        workspaceId: session.workspace_id,
        transcript: turns
          .slice()
          .reverse()
          .map(({ speaker, content }) => ({
            speaker,
            content: content.slice(0, summary ? 800 : 500),
          })),
        lead,
        previous: summary ? undefined : session.suggestion?.line,
        onCue: summary ? undefined : publishCue,
      });
      failed = !result.output;
    }
  } catch (error) {
    failed = true;
    console.error(
      "Call assist analysis failed:",
      error.status || error.code || "model unavailable",
    );
  }
  const currentlyEnabled = canCapture(config(), session);
  if (summary) {
    const output = currentlyEnabled && result?.output;
    const retry = currentlyEnabled && failed && session.summary_attempts < 3;
    const state = output
      ? "ready"
      : retry
        ? "pending"
        : failed
          ? "unavailable"
          : "empty";
    await pool.query(
      `WITH saved AS (
        UPDATE phone_call_sessions SET summary = $3, summary_state = $4,
         summary_at = CASE WHEN $4 = 'pending' THEN now() + interval '20 seconds' ELSE now() END,
         model_lease_until = NULL, model_lease_id = NULL,
         input_tokens = input_tokens + $5, output_tokens = output_tokens + $6,
         updated_at = now() WHERE id = $1 AND model_lease_id = $2 RETURNING id
       ) DELETE FROM phone_call_utterances WHERE session_id IN (SELECT id FROM saved)
          AND $4 = 'ready' AND NOT $7`,
      [
        row.id,
        lease,
        output ? JSON.stringify(output) : null,
        state,
        result?.input || 0,
        result?.tokens || 0,
        settings.retainTranscript,
      ],
    );
    publish();
    return;
  }
  const line = result?.output?.line?.trim().slice(0, 500);
  const timing = earlyCue?.line === line ? earlyCue : measure(Date.now());
  const suggestion =
    currentlyEnabled &&
    line &&
    line.toLowerCase() !== session.suggestion?.line?.toLowerCase()
      ? JSON.stringify({
          ...timing,
          line,
          hint: result.output.hint?.slice(0, 300),
        })
      : null;
  const {
    rows: [saved],
  } = await pool.query(
    `UPDATE phone_call_sessions SET
       suggestion = CASE WHEN capture_ended_at IS NULL AND NOT stop_requested
           AND NOT EXISTS (SELECT 1 FROM phone_call_utterances WHERE session_id = $1
               AND speaker = 'Caller' AND sequence_id > $4)
         THEN COALESCE($3::jsonb, suggestion) ELSE suggestion END,
       suggestion_failed = $5, model_lease_until = NULL, model_lease_id = NULL,
       input_tokens = input_tokens + $6, output_tokens = output_tokens + $7, updated_at = now()
     WHERE id = $1 AND model_lease_id = $2 RETURNING suggestion`,
    [
      row.id,
      lease,
      suggestion,
      latestCaller?.sequence_id ?? -1,
      failed,
      result?.input || 0,
      result?.tokens || 0,
    ],
  );
  if (
    !earlyCue &&
    suggestion &&
    saved?.suggestion?.generatedAt === timing.generatedAt
  )
    logTiming(timing);
  events.emit(row.id);
}

async function cleanup(settings) {
  await pool.query(
    `DELETE FROM phone_call_utterances u USING phone_call_sessions s
     WHERE u.session_id = s.id AND s.capture_ended_at <
      now() - CASE WHEN $1 THEN interval '7 days' ELSE interval '24 hours' END`,
    [settings.retainTranscript],
  );
  await pool.query(
    `DELETE FROM phone_call_sessions WHERE call_sid IS NULL AND created_at < now() - interval '1 day'`,
  );
  await pool.query(
    `UPDATE phone_call_sessions SET summary = NULL,
      suggestion = NULL, summary_state = 'empty', updated_at = now()
     WHERE capture_ended_at < now() - interval '30 days'
       AND (summary IS NOT NULL OR suggestion IS NOT NULL)`,
  );
}

function startWorker() {
  let running = false;
  let nextCleanup = 0;
  let nextCheck = 0;
  const jobs = new Map();
  const dispatch = (key, operation) => {
    if (jobs.has(key) || jobs.size >= 16) return;
    jobs.set(
      key,
      operation()
        .catch((error) => {
          console.error("Call assist job failed:", error.code || "unavailable");
        })
        .finally(() => jobs.delete(key)),
    );
  };
  async function tick() {
    if (running || Date.now() < nextCheck) return;
    running = true;
    try {
      const settings = config();
      const { rows } = await pool.query(
        `SELECT s.*, l.status AS leg_status
         FROM phone_call_sessions s LEFT JOIN LATERAL (
           SELECT status FROM twilio_call_legs WHERE parent_call_sid = s.call_sid
             AND workspace_id = s.workspace_id
             AND provider_connection_id IS NOT DISTINCT FROM s.provider_connection_id
           ORDER BY updated_at DESC LIMIT 1
         ) l ON true
         WHERE s.assist AND s.call_sid IS NOT NULL
            AND (s.capture_ended_at IS NULL
              OR (s.ended_at IS NULL AND s.created_at > now() - interval '1 hour')
              OR (s.capture_started_at IS NOT NULL AND NOT s.stop_confirmed
                AND s.created_at > now() - interval '1 hour')
              OR s.summary_state = 'pending'
              OR (s.summary_state = 'none' AND s.created_at > now() - interval '24 hours'))
         ORDER BY s.created_at LIMIT 60`,
      );
      for (const row of rows) {
        dispatch(`capture:${row.id}`, () => processCapture(row, settings));
        if (!canCapture(settings, row)) {
          dispatch(`model:${row.id}`, () =>
            pool.query(
              `UPDATE phone_call_sessions SET summary_state = 'empty', next_suggestion_at = NULL,
               model_lease_id = NULL, model_lease_until = NULL, updated_at = now()
             WHERE id = $1 AND (summary_state IN ('none', 'pending') OR next_suggestion_at IS NOT NULL)`,
              [row.id],
            ),
          );
        } else if (row.capture_ended_at || row.next_suggestion_at) {
          dispatch(`model:${row.id}`, () =>
            runModel(
              row,
              settings,
              row.capture_ended_at ? "summary" : "suggestion",
            ),
          );
        }
      }
      if (Date.now() >= nextCleanup) {
        await cleanup(settings);
        nextCleanup = Date.now() + 3600000;
      }
    } catch (error) {
      if (error.code !== "42P01")
        console.error(
          "Call assist worker failed:",
          error.code || "unavailable",
        );
      nextCheck = Date.now() + 30000;
    } finally {
      running = false;
    }
  }
  const timer = setInterval(tick, 350);
  timer.unref();
  events.on("caller-turn", tick);
  return () => {
    clearInterval(timer);
    events.off("caller-turn", tick);
  };
}

module.exports = { startWorker, processCapture, runModel, cleanup };
