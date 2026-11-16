const { getConfig } = require("../../src/receptionist/config");
const { GREETING } = require("../../src/receptionist/twiml");
const {
  FALLBACK_LINE,
  STILL_THERE_LINE,
  SILENT_END_LINE,
  WRAP_UP_LINE,
} = require("../../src/receptionist/prompt");
const { createSession, speakMs } = require("../../src/receptionist/session");

const sid = `CA${"1".repeat(32)}`;
const config = getConfig({});
const context = {
  callSid: sid,
  workspaceId: "00000000-0000-4000-8000-000000000001",
  connectionId: null,
  from: "+15551230009",
};
const prompt = (text) => ({ type: "prompt", voicePrompt: text, last: true });
const flush = () => new Promise((resolve) => setImmediate(resolve));
const text = (token) => ({ type: "text", token, last: false });
const LAST = { type: "text", token: "", last: true };

// What agent.runTurn resolves with after saying `spoken`.
const reply =
  (spoken, extra = {}) =>
  async (history, { onText }) => {
    if (spoken) onText(spoken);
    return {
      history: spoken
        ? [
            ...history,
            { role: "assistant", content: [{ type: "text", text: spoken }] },
          ]
        : history,
      spoken,
      end: null,
      carrier: null,
      failed: false,
      ...extra,
    };
  };

let sent;
let agent;
let onFinished;
let close;
function start(overrides = {}) {
  sent = [];
  close = jest.fn();
  onFinished = jest.fn();
  agent = {
    prewarm: jest.fn().mockResolvedValue(),
    runTurn: jest.fn(reply("Sure.")),
  };
  const session = createSession({
    send: (message) => sent.push(message),
    close,
    agent,
    config,
    context,
    onFinished,
    now: () => new Date("2026-11-16T15:00:00Z").getTime(),
    ...overrides,
  });
  session.handle({ type: "setup", callSid: sid });
  return session;
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test("speech time is estimated from length and kept within bounds", () => {
  expect(speakMs("Hi.")).toBe(1500);
  expect(speakMs("x".repeat(100))).toBe(7000);
  expect(speakMs("x".repeat(1000))).toBe(12000);
});

test("setup seeds history with the call context and greeting and pre-warms", async () => {
  const s = start();
  await s.handle(prompt("I need a dispatcher"));
  const history = agent.runTurn.mock.calls[0][0];
  expect(history[0].role).toBe("user");
  expect(history[0].content).toMatch(/^<call_context>/);
  expect(history[0].content).toMatch(/number is known/);
  expect(history[0].content).toMatch(/office is open/);
  expect(history[1]).toEqual({ role: "assistant", content: GREETING });
  expect(history[2]).toEqual({ role: "user", content: "I need a dispatcher" });
  expect(agent.prewarm).toHaveBeenCalledTimes(1);
});

test("a blocked caller ID is flagged in the call context", async () => {
  const s = start({ context: { ...context, from: "anonymous" } });
  await s.handle(prompt("hello"));
  expect(agent.runTurn.mock.calls[0][0][0].content).toMatch(
    /number is not known/,
  );
});

test("a caller turn streams tokens and closes the talk cycle", async () => {
  const s = start();
  agent.runTurn.mockImplementation(async (h, { onText }) => {
    onText("Sure. ");
    onText("Go ahead.");
    return { ...(await reply("")(h, { onText })), spoken: "Sure. Go ahead." };
  });
  await s.handle(prompt("I need a dispatcher"));
  expect(sent).toEqual([text("Sure. "), text("Go ahead."), LAST]);
});

test("partial prompts are ignored", async () => {
  const s = start();
  await s.handle({ type: "prompt", voicePrompt: "I need", last: false });
  expect(agent.runTurn).not.toHaveBeenCalled();
});

test("keyed digits followed by # become one caller turn", async () => {
  const s = start();
  for (const digit of "196057#") await s.handle({ type: "dtmf", digit });
  await flush();
  expect(agent.runTurn.mock.calls[0][0].at(-1)).toEqual({
    role: "user",
    content: "(keyed in) 196057",
  });
});

test("keyed digits are submitted after two quiet seconds", async () => {
  const s = start();
  for (const digit of "1960") await s.handle({ type: "dtmf", digit });
  await jest.advanceTimersByTimeAsync(1999);
  expect(agent.runTurn).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(2);
  await flush();
  expect(agent.runTurn.mock.calls[0][0].at(-1).content).toBe("(keyed in) 1960");
});

test("an interruption trims the record to what was heard", async () => {
  const s = start();
  agent.runTurn.mockImplementationOnce(
    reply("Our plans start at a flat weekly fee"),
  );
  await s.handle(prompt("how much is it"));
  await s.handle({
    type: "interrupt",
    utteranceUntilInterrupt: "Our plans start",
    durationUntilInterruptMs: 900,
  });
  await s.handle(prompt("wait, is it a percentage?"));
  const history = agent.runTurn.mock.calls[1][0];
  expect(history.at(-2)).toEqual({
    role: "assistant",
    content: [{ type: "text", text: "Our plans start" }],
  });
  s.closed();
  await flush();
  const { transcript } = onFinished.mock.calls[0][0];
  expect(transcript).toContainEqual({ role: "agent", text: "Our plans start" });
  expect(JSON.stringify(transcript)).not.toContain("flat weekly fee");
});

test("an interruption aborts the turn that is still running", async () => {
  const s = start();
  let signalSeen;
  agent.runTurn.mockImplementationOnce(
    (history, { onText, signal }) =>
      new Promise((resolve) => {
        signalSeen = signal;
        onText("Let me explain how");
        signal.addEventListener("abort", () =>
          resolve({
            history: [
              ...history,
              {
                role: "assistant",
                content: [{ type: "text", text: "Let me explain how" }],
              },
            ],
            spoken: "Let me explain how",
            end: null,
            carrier: null,
            failed: false,
          }),
        );
      }),
  );
  s.handle(prompt("tell me everything"));
  await flush();
  await s.handle({ type: "interrupt", utteranceUntilInterrupt: "Let me" });
  await flush();
  expect(signalSeen.aborted).toBe(true);
  // An interrupted reply is not closed with a final token; Twilio already
  // stopped speaking.
  expect(sent).toEqual([text("Let me explain how")]);
  await s.handle(prompt("never mind, what's the price?"));
  expect(agent.runTurn.mock.calls[1][0].at(-2).content).toEqual([
    { type: "text", text: "Let me" },
  ]);
});

test("a new caller turn supersedes one that is still running", async () => {
  const s = start();
  agent.runTurn.mockImplementationOnce(
    (history, { signal }) =>
      new Promise((resolve) =>
        signal.addEventListener("abort", () =>
          resolve({
            history,
            spoken: "",
            end: null,
            carrier: null,
            failed: false,
          }),
        ),
      ),
  );
  s.handle(prompt("my MC is"));
  await flush();
  await s.handle(prompt("one nine six zero five seven"));
  expect(agent.runTurn).toHaveBeenCalledTimes(2);
  expect(
    agent.runTurn.mock.calls[1][0].slice(-2).map((message) => message.content),
  ).toEqual(["my MC is", "one nine six zero five seven"]);
});

test("end_call waits for the goodbye, then ends the session once", async () => {
  const s = start();
  agent.runTurn.mockImplementation(
    reply("x".repeat(100), {
      end: { outcome: "lead", callbackPromise: "next few minutes" },
    }),
  );
  await s.handle(prompt("that's all"));
  await jest.advanceTimersByTimeAsync(6999);
  expect(sent.some((m) => m.type === "end")).toBe(false);
  await jest.advanceTimersByTimeAsync(2);
  expect(sent.filter((m) => m.type === "end")).toEqual([
    { type: "end", handoffData: JSON.stringify({ outcome: "lead" }) },
  ]);
  s.closed(); // Twilio closes the socket after the end message
  await flush();
  expect(onFinished).toHaveBeenCalledTimes(1);
  expect(onFinished.mock.calls[0][0]).toMatchObject({
    callSid: sid,
    outcome: "lead",
    callbackPromise: "next few minutes",
    callerSpoke: true,
  });
});

test("a caller who speaks over the goodbye keeps the call alive", async () => {
  const s = start();
  agent.runTurn.mockImplementationOnce(
    reply("Thanks, talk soon.", {
      end: { outcome: "lead", callbackPromise: "next few minutes" },
    }),
  );
  await s.handle(prompt("ok"));
  await s.handle({ type: "interrupt", utteranceUntilInterrupt: "Thanks" });
  await jest.advanceTimersByTimeAsync(20000);
  expect(sent.some((m) => m.type === "end")).toBe(false);
  await s.handle(prompt("wait, one more question"));
  expect(agent.runTurn.mock.calls[1][0].at(-1).content).toMatch(
    /call is still live[\s\S]*wait, one more question/,
  );
  expect(onFinished).not.toHaveBeenCalled();
});

test("a failed turn says the fallback line and ends as failed", async () => {
  const s = start();
  agent.runTurn.mockImplementation(reply("", { failed: true }));
  await s.handle(prompt("hello?"));
  expect(sent).toEqual([{ type: "text", token: FALLBACK_LINE, last: true }]);
  await jest.advanceTimersByTimeAsync(speakMs(FALLBACK_LINE) + 1);
  expect(sent.at(-1)).toEqual({
    type: "end",
    handoffData: JSON.stringify({ outcome: "failed" }),
  });
  expect(onFinished.mock.calls[0][0]).toMatchObject({
    outcome: "failed",
    callerSpoke: true,
  });
  expect(onFinished.mock.calls[0][0].transcript.at(-1)).toEqual({
    role: "agent",
    text: FALLBACK_LINE,
  });
});

test("silence: one check-in, then a polite end, saved as abandoned", async () => {
  start();
  await jest.advanceTimersByTimeAsync(speakMs(GREETING) + 11999);
  expect(sent).toEqual([]);
  await jest.advanceTimersByTimeAsync(2);
  expect(sent).toEqual([{ type: "text", token: STILL_THERE_LINE, last: true }]);
  await jest.advanceTimersByTimeAsync(speakMs(STILL_THERE_LINE) + 12001);
  expect(sent.at(-1)).toEqual({
    type: "text",
    token: SILENT_END_LINE,
    last: true,
  });
  await jest.advanceTimersByTimeAsync(speakMs(SILENT_END_LINE) + 1);
  expect(sent.at(-1)).toEqual({
    type: "end",
    handoffData: JSON.stringify({ outcome: "abandoned" }),
  });
  expect(agent.runTurn).not.toHaveBeenCalled();
  expect(onFinished).toHaveBeenCalledTimes(1);
  expect(onFinished.mock.calls[0][0]).toMatchObject({
    outcome: "abandoned",
    callerSpoke: false,
  });
});

test("the silence check restarts when the caller answers", async () => {
  const s = start();
  await jest.advanceTimersByTimeAsync(speakMs(GREETING) + 12001);
  await s.handle(prompt("yes I'm here"));
  await jest.advanceTimersByTimeAsync(speakMs("Sure.") + 11000);
  expect(sent.filter((m) => m.token === SILENT_END_LINE)).toEqual([]);
  expect(onFinished).not.toHaveBeenCalled();
});

test("caller hangs up during a lookup: turn aborted, finished once, no unhandled rejection", async () => {
  const s = start();
  agent.runTurn.mockImplementation(
    (history, { signal }) =>
      new Promise((resolve) =>
        signal.addEventListener("abort", () =>
          resolve({
            history,
            spoken: "",
            end: null,
            carrier: null,
            failed: false,
          }),
        ),
      ),
  );
  s.handle(prompt("my MC is 196057"));
  await flush();
  s.closed();
  s.closed();
  await flush();
  expect(onFinished).toHaveBeenCalledTimes(1);
  expect(onFinished.mock.calls[0][0]).toMatchObject({
    outcome: "lead",
    callerSpoke: true,
  });
  expect(onFinished.mock.calls[0][0].transcript.at(-1)).toEqual({
    role: "caller",
    text: "my MC is 196057",
  });
});

test("a caller who hangs up without speaking is abandoned", async () => {
  const s = start();
  s.closed();
  await flush();
  expect(onFinished.mock.calls[0][0]).toMatchObject({
    outcome: "abandoned",
    callerSpoke: false,
    transcript: [{ role: "agent", text: GREETING }],
  });
});

test("the carrier found during the call is reported", async () => {
  const s = start();
  const carrier = { found: true, mc: "196057", legalName: "SMITH TRUCKING" };
  agent.runTurn.mockImplementationOnce(reply("Is that you?", { carrier }));
  await s.handle(prompt("MC 196057"));
  s.closed();
  await flush();
  expect(onFinished.mock.calls[0][0].carrier).toEqual(carrier);
});

test("the call is wrapped up at the maximum length", async () => {
  // A short limit, so it is reached before the silence check would end the call.
  const s = start({ config: { ...config, maxCallSeconds: 5 } });
  await s.handle(prompt("so let me tell you about my truck"));
  await jest.advanceTimersByTimeAsync(5000);
  agent.runTurn.mockClear();
  sent.length = 0;
  await s.handle(prompt("and another thing"));
  expect(agent.runTurn).not.toHaveBeenCalled();
  expect(sent).toEqual([{ type: "text", token: WRAP_UP_LINE, last: true }]);
  await jest.advanceTimersByTimeAsync(speakMs(WRAP_UP_LINE) + 1);
  expect(sent.at(-1).type).toBe("end");
  expect(onFinished.mock.calls[0][0]).toMatchObject({ outcome: "lead" });
});

test("messages after the end are ignored and a dead socket does not throw", async () => {
  const s = start({
    send: () => {
      throw new Error("socket closed");
    },
  });
  await expect(s.handle(prompt("hello"))).resolves.toBeUndefined();
  s.closed();
  await flush();
  agent.runTurn.mockClear();
  await s.handle(prompt("anyone there?"));
  expect(agent.runTurn).not.toHaveBeenCalled();
  expect(onFinished).toHaveBeenCalledTimes(1);
});

test("malformed messages are ignored", async () => {
  const s = start();
  await s.handle(null);
  await s.handle({ type: "prompt", last: true });
  await s.handle({ type: "dtmf", digit: "x" });
  await s.handle({ type: "error", description: "bad" });
  expect(agent.runTurn).not.toHaveBeenCalled();
});
