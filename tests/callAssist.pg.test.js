// Use a throwaway database with a name ending in _test. No external Twilio or
// Anthropic calls are made.
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("node:crypto");

const mockCreate = jest.fn();
const mockStop = jest.fn();
jest.mock("twilio", () => () => ({
  calls: () => ({
    transcriptions: Object.assign(() => ({ update: mockStop }), {
      create: mockCreate,
    }),
  }),
}));
jest.mock("../src/connectionWebhooks", () => ({
  loadConnectionAuth: jest.fn(),
}));
jest.mock("../src/token", () => ({
  accountSid: "AC" + "a".repeat(32),
  authToken: "synthetic",
  callerId: "+12025550100",
  getIdentity: () => "operator",
}));
jest.mock("../src/callAssist/model", () => ({ analyze: jest.fn() }));

const url = process.env.DB_URL;
const enabled =
  process.env.CALL_ASSIST_PG_TEST === "1" &&
  url &&
  new URL(url).pathname.endsWith("_test");
const suite = enabled ? describe : describe.skip;

suite("Call assist against PostgreSQL", () => {
  const workspace = "00000000-0000-4000-8000-000000000001";
  const otherWorkspace = "00000000-0000-4000-8000-000000000002";
  const connection = "00000000-0000-4000-8000-000000000003";
  const from = "+12025550100";
  const destination = "+12025550111";
  const accountSid = "AC" + "a".repeat(32);
  const callSid = "CA" + "a".repeat(32);
  const childSid = "CA" + "b".repeat(32);
  const transcriptionSid = "GT" + "a".repeat(32);

  const pool = require("../src/db");
  const { config } = require("../src/callAssist/config");
  const {
    getAssistantSettings,
    updateAssistantSettings,
  } = require("../src/assistantSettings");
  const { bindIntent, ingest } = require("../src/callAssist/store");
  const { processCapture, runModel } = require("../src/callAssist/worker");
  const { loadConnectionAuth } = require("../src/connectionWebhooks");
  const { readCaptions } = require("../src/callAssist/live");
  const { analyze } = require("../src/callAssist/model");

  let id;
  const response = () => ({ sendStatus: jest.fn() });
  const read = async (leg_status = "in-progress") => ({
    ...(
      await pool.query("SELECT * FROM phone_call_sessions WHERE id = $1", [id])
    ).rows[0],
    leg_status,
  });
  const utterances = () =>
    pool.query(
      "SELECT * FROM phone_call_utterances WHERE session_id = $1 ORDER BY sequence_id",
      [id],
    );

  beforeAll(async () => {
    Object.assign(process.env, {
      CALL_ASSIST_ENABLED: "true",
      CALL_ASSIST_RETAIN_TRANSCRIPT: "false",
      TWILIO_WEBHOOK_BASE_URL: "https://example.test",
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS workspaces (id uuid PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS provider_connections (id uuid PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS twilio_call_legs (
        call_sid text PRIMARY KEY, parent_call_sid text, workspace_id uuid,
        provider_connection_id uuid, status text, updated_at timestamptz DEFAULT now()
      );
    `);
    const sql = fs.readFileSync(
      path.join(__dirname, "../migrations/010_call_assist.sql"),
      "utf8",
    );
    await pool.query(sql);
    await pool.query(sql);
    const settingsMigration = fs.readFileSync(
      path.join(
        __dirname,
        "../migrations/011_workspace_assistant_settings.sql",
      ),
      "utf8",
    );
    await pool.query(settingsMigration);
    await pool.query(settingsMigration);
    await pool.query(
      "INSERT INTO workspaces VALUES ($1), ($2) ON CONFLICT DO NOTHING",
      [workspace, otherWorkspace],
    );
    await pool.query(
      "INSERT INTO provider_connections VALUES ($1) ON CONFLICT DO NOTHING",
      [connection],
    );
  }, 30000);

  beforeEach(async () => {
    id = randomUUID();
    jest.resetAllMocks();
    loadConnectionAuth.mockResolvedValue({
      workspaceId: workspace,
      accountSid,
      authToken: "synthetic",
    });
    mockCreate.mockResolvedValue({ sid: transcriptionSid });
    await pool.query(
      "TRUNCATE phone_call_utterances, phone_call_sessions, twilio_call_legs, workspace_assistant_settings",
    );
    await pool.query(
      `INSERT INTO phone_call_sessions
       (id, workspace_id, provider_connection_id, account_sid, from_number, destination, assist)
       VALUES ($1, $2, $3, $4, $5, $6, true)`,
      [id, workspace, connection, accountSid, from, destination],
    );
  });

  function binding() {
    const body = {
      AssistIntent: id,
      From: "client:" + "connection_" + connection.replace(/-/g, ""),
      To: destination,
      CallSid: callSid,
      AccountSid: accountSid,
    };
    const provider = {
      id: connection,
      workspaceId: workspace,
      accountSid,
      phoneNumber: from,
    };
    return { body, provider };
  }

  it("binds an intent only to its workspace and canonical call", async () => {
    const { body, provider } = binding();
    await bindIntent(body, { ...provider, workspaceId: otherWorkspace });
    expect((await read()).call_sid).toBeNull();
    await bindIntent(body, provider);
    await bindIntent({ ...body, CallSid: childSid }, provider);
    expect((await read()).call_sid).toBe(callSid);
  });

  it("binds an intent placed from a user's softphone identity", async () => {
    const { body, provider } = binding();
    await bindIntent(
      {
        ...body,
        From:
          "client:u" +
          "aaaaaaaa111141118111111111111111" +
          "_c" +
          connection.replace(/-/g, ""),
      },
      provider,
    );
    expect((await read()).call_sid).toBe(callSid);
  });

  it("defaults both switches on and saves independent workspace preferences", async () => {
    expect(await getAssistantSettings(workspace)).toEqual({
      jack: true,
      liveAssist: true,
    });
    await Promise.all([
      updateAssistantSettings(workspace, { jack: false }),
      updateAssistantSettings(workspace, { liveAssist: false }),
    ]);
    expect(await getAssistantSettings(workspace)).toEqual({
      jack: false,
      liveAssist: false,
    });
    expect(await getAssistantSettings(otherWorkspace)).toEqual({
      jack: true,
      liveAssist: true,
    });
    expect(await updateAssistantSettings(workspace, { jack: true })).toEqual({
      jack: true,
      liveAssist: false,
    });
  });

  it("links a normal call when Live Assist is turned off before binding", async () => {
    const { body, provider } = binding();
    await updateAssistantSettings(workspace, { liveAssist: false });
    await bindIntent(body, provider);
    expect(await read()).toMatchObject({ call_sid: callSid, assist: false });
  });

  afterAll(async () => {
    await pool.end();
  });

  async function send(
    event,
    fields = {},
    owner = workspace,
    connectionId = connection,
  ) {
    const result = response();
    await ingest(
      {
        params: { sessionId: id },
        providerConnection: {
          workspaceId: owner,
          id: connectionId,
          accountSid,
        },
        body: {
          CallSid: callSid,
          TranscriptionSid: transcriptionSid,
          TranscriptionEvent: event,
          ...fields,
        },
      },
      result,
    );
    expect(result.sendStatus).toHaveBeenCalledWith(204);
  }

  const finalTurn = (sequence, track, line) => ({
    SequenceId: String(sequence),
    Track: track,
    Final: "true",
    TranscriptionData: JSON.stringify({ transcript: line }),
  });

  it("allows Live Assist in a second workspace", async () => {
    const { body, provider } = binding();
    await pool.query(
      "UPDATE phone_call_sessions SET workspace_id = $2 WHERE id = $1",
      [id, otherWorkspace],
    );
    await bindIntent(body, { ...provider, workspaceId: otherWorkspace });
    expect(await read()).toMatchObject({ call_sid: callSid, assist: true });
  });

  it("allows valid numbers outside the previous pilot", async () => {
    const { body, provider } = binding();
    const otherDestination = "+12025550199";
    await pool.query(
      "UPDATE phone_call_sessions SET destination = $2 WHERE id = $1",
      [id, otherDestination],
    );
    await bindIntent({ ...body, To: otherDestination }, provider);
    expect(await read()).toMatchObject({ call_sid: callSid, assist: true });
  });

  it("keeps a non-phone destination unassisted", async () => {
    const { body, provider } = binding();
    const invalidDestination = "operator";
    await pool.query(
      "UPDATE phone_call_sessions SET destination = $2 WHERE id = $1",
      [id, invalidDestination],
    );
    await bindIntent({ ...body, To: invalidDestination }, provider);
    expect(await read()).toMatchObject({ call_sid: callSid, assist: false });
  });

  it("starts and receives transcription on the default environment connection", async () => {
    const { body, provider } = binding();
    await pool.query(
      "UPDATE phone_call_sessions SET provider_connection_id = NULL WHERE id = $1",
      [id],
    );
    await bindIntent(
      { ...body, From: "client:operator" },
      { ...provider, id: null, legacy: true },
    );
    expect(await read()).toMatchObject({
      call_sid: callSid,
      assist: true,
      provider_connection_id: null,
    });
    await processCapture(await read(), config());
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCallbackUrl: `https://example.test/transcription/${id}`,
      }),
    );
    await send(
      "transcription-content",
      finalTurn(1, "outbound_track", "A test call"),
      workspace,
      null,
    );
    expect((await utterances()).rowCount).toBe(1);
  });

  it("captures once on answer, deduplicates callbacks, and finalizes after late utterances", async () => {
    const { body, provider } = binding();
    await bindIntent(body, provider);
    await processCapture(await read("ringing"), config());
    expect(mockCreate).not.toHaveBeenCalled();
    const row = await read();
    await Promise.all([
      processCapture(row, config()),
      processCapture(row, config()),
    ]);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ track: "both_tracks", partialResults: true }),
    );
    const turn = finalTurn(4, "outbound_track", "Two reefers");
    await send("transcription-content", turn, otherWorkspace);
    expect((await utterances()).rowCount).toBe(0);
    await send("transcription-content", turn);
    await send("transcription-content", turn);
    await send(
      "transcription-content",
      finalTurn(3, "inbound_track", "What are you running?"),
    );
    expect((await utterances()).rows.map((entry) => entry.speaker)).toEqual([
      "Dispatcher",
      "Caller",
    ]);

    await pool.query(
      "UPDATE phone_call_sessions SET next_suggestion_at = now() WHERE id = $1",
      [id],
    );
    analyze.mockResolvedValueOnce({
      output: { line: "Which lanes do you run?", hint: null },
      input: 10,
      tokens: 5,
    });
    await runModel(await read(), config(), "suggestion");
    expect((await read()).suggestion.line).toBe("Which lanes do you run?");

    await processCapture(await read("completed"), config());
    await send("transcription-stopped");
    await send(
      "transcription-content",
      finalTurn(5, "outbound_track", "The Midwest"),
    );
    await pool.query(
      "UPDATE phone_call_sessions SET capture_ended_at = now() - interval '9 seconds' WHERE id = $1",
      [id],
    );
    const summary = { outcome: "Follow up", commitments: [], unanswered: [] };
    analyze.mockResolvedValueOnce({ output: summary, input: 10, tokens: 5 });
    await runModel(await read("completed"), config(), "summary");
    expect(analyze).toHaveBeenLastCalledWith(
      expect.objectContaining({
        transcript: expect.arrayContaining([
          { speaker: "Caller", content: "The Midwest" },
        ]),
      }),
    );
    expect(await read()).toMatchObject({
      summary,
      summary_state: "ready",
      input_tokens: "20",
    });
    expect((await utterances()).rowCount).toBe(0);
  });

  it("shows interim captions without saving them or scheduling the model", async () => {
    const { body, provider } = binding();
    await bindIntent(body, provider);
    await processCapture(await read(), config());
    const interim = {
      ...finalTurn(1, "outbound_track", "What is the"),
      Final: "false",
    };
    await send("transcription-content", interim, otherWorkspace);
    expect(readCaptions(id)).toEqual([]);
    await send("transcription-content", interim);
    expect(readCaptions(id)).toMatchObject([
      { text: "What is the", final: false },
    ]);
    expect((await utterances()).rowCount).toBe(0);
    expect((await read()).next_suggestion_at).toBeNull();

    await send(
      "transcription-content",
      finalTurn(2, "outbound_track", "What is the deadline?"),
    );
    await send("transcription-content", interim);
    expect(readCaptions(id)).toMatchObject([{ sequence: 2, final: true }]);
    expect((await utterances()).rowCount).toBe(1);

    let firstCue;
    analyze.mockImplementationOnce(async ({ onCue }) => {
      await onCue("What is the load number?");
      firstCue = (await read()).suggestion;
      return { output: { line: firstCue.line, hint: "Check the schedule" } };
    });
    await runModel(await read(), config(), "suggestion");
    expect(firstCue).toMatchObject({
      line: "What is the load number?",
      modelMs: expect.any(Number),
    });
    expect((await read()).suggestion).toEqual({
      ...firstCue,
      hint: "Check the schedule",
    });

    await send("transcription-stopped");
    await send("transcription-content", { ...interim, SequenceId: "3" });
    expect(readCaptions(id)).toEqual([]);
  });

  it("runs the next suggestion once the start-to-start interval has passed", async () => {
    const { body, provider } = binding();
    await bindIntent(body, provider);
    await processCapture(await read(), config());
    await send(
      "transcription-content",
      finalTurn(1, "outbound_track", "What is the pickup deadline?"),
    );
    await pool.query(
      `UPDATE phone_call_sessions
      SET next_suggestion_at = now(), last_suggestion_at = now() - interval '2 seconds' WHERE id = $1`,
      [id],
    );
    analyze.mockResolvedValueOnce({
      output: { line: "What is the load reference?" },
    });
    await runModel(await read(), config(), "suggestion");
    const result = await read();
    expect(result.suggestion.line).toBe("What is the load reference?");
    expect(result.suggestion).toEqual(
      expect.objectContaining({
        latencyMs: expect.any(Number),
        queueMs: expect.any(Number),
        modelMs: expect.any(Number),
      }),
    );
  });

  it("keeps the call active when stopping capture and never starts capture on no answer", async () => {
    const { body, provider } = binding();
    await bindIntent(body, provider);
    await processCapture(await read(), config());
    await pool.query(
      "UPDATE phone_call_sessions SET stop_requested = true WHERE id = $1",
      [id],
    );
    await processCapture(await read(), config());
    expect(mockStop).toHaveBeenCalledWith({ status: "stopped" });
    expect(await read()).toMatchObject({
      capture_state: "stopped",
      partial: true,
      ended_at: null,
    });
    await processCapture(await read("no-answer"), config());
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
