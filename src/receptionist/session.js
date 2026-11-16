/* One phone call with the AI receptionist, as a ConversationRelay session.

Twilio sends the caller's words as text; this turns each caller turn into an
agent turn and sends the reply back as text for Twilio to speak. It also owns
everything that makes a phone call different from a chat: the caller talking
over the agent, keyed-in digits, silence, a maximum length, and the caller
hanging up at any moment. Whatever happens, onFinished is called exactly once
with the record of the call. */

const { isOpen } = require("./config");
const { GREETING } = require("./twiml");
const {
  callContext,
  FALLBACK_LINE,
  STILL_THERE_LINE,
  SILENT_END_LINE,
  WRAP_UP_LINE,
} = require("./prompt");
const { callableNumber } = require("./phone");

const SILENCE_MS = 12_000;
const DTMF_PAUSE_MS = 2_000;
const CLOSE_GRACE_MS = 5_000;
const STILL_LIVE_NOTE =
  "(The caller spoke again before the call ended, so the call is still live.)";

// Roughly how long the voice takes to say `text`. Twilio does not report
// when speech has finished, so waits that must not cut the agent off (the
// goodbye before hanging up, the silence check) are sized from this.
function speakMs(text) {
  return Math.min(12_000, Math.max(1_500, String(text || "").length * 70));
}

// The part of `text` the caller heard, given what Twilio says was spoken
// before the interruption.
function heardPart(text, heard) {
  if (!heard) return "";
  for (let length = Math.min(text.length, heard.length); length > 0; length--)
    if (heard.endsWith(text.slice(0, length))) return text.slice(0, length);
  return heard;
}

function createSession({
  send,
  close,
  agent,
  config,
  context,
  onFinished,
  now = Date.now,
}) {
  let history = null; // null until setup
  const transcript = [];
  let carrier = null;
  let callerSpoke = false;
  let finished = false;
  let current = null; // the running turn's AbortController
  let queue = Promise.resolve();
  let pendingEnd = null; // { outcome, callbackPromise } while the goodbye plays
  let endInterrupted = false;
  let wrapUp = false;
  let silenceStage = 0;
  let dtmf = "";
  let silenceTimer;
  let endTimer;
  let dtmfTimer;
  let maxTimer;

  function safeSend(message) {
    try {
      send(message);
    } catch (error) {
      console.error("Receptionist send failed:", error.message);
    }
  }

  // Runs `task` after everything already queued, so turns and the
  // bookkeeping that follows an interruption never interleave.
  function enqueue(task) {
    queue = queue.then(task).catch((error) => {
      console.error("Receptionist session step failed:", error.message);
    });
    return queue;
  }

  // The agent's token counts, for the cost of the call. Never worth failing
  // the end of a call over.
  function usageSoFar() {
    try {
      return agent.usage?.() || [];
    } catch {
      return [];
    }
  }

  function finish(outcome, callbackPromise) {
    if (finished) return;
    finished = true;
    for (const timer of [silenceTimer, endTimer, dtmfTimer, maxTimer])
      clearTimeout(timer);
    current?.abort();
    try {
      onFinished({
        callSid: context.callSid,
        outcome,
        callbackPromise: callbackPromise || null,
        carrier,
        transcript,
        callerSpoke,
        usage: usageSoFar(),
      });
    } catch (error) {
      console.error("Receptionist finish handler failed:", error.message);
    }
  }

  function startSilenceTimer(afterText) {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(onSilence, speakMs(afterText) + SILENCE_MS);
  }

  function sayFixed(line) {
    transcript.push({ role: "agent", text: line });
    if (history) history.push({ role: "assistant", content: line });
    safeSend({ type: "text", token: line, last: true });
  }

  // Ends the session once the closing words have had time to play.
  function scheduleEnd(outcome, closingWords, callbackPromise) {
    clearTimeout(silenceTimer);
    pendingEnd = { outcome, callbackPromise };
    endTimer = setTimeout(() => {
      if (finished) return;
      safeSend({ type: "end", handoffData: JSON.stringify({ outcome }) });
      finish(outcome, callbackPromise);
      // Twilio closes the socket after an end message; this is the backstop.
      const timer = setTimeout(() => close?.(), CLOSE_GRACE_MS);
      timer.unref?.();
    }, speakMs(closingWords));
  }

  function onSilence() {
    if (finished || pendingEnd || current) return;
    if (silenceStage === 0) {
      silenceStage = 1;
      sayFixed(STILL_THERE_LINE);
      startSilenceTimer(STILL_THERE_LINE);
      return;
    }
    sayFixed(SILENT_END_LINE);
    scheduleEnd(callerSpoke ? "lead" : "abandoned", SILENT_END_LINE);
  }

  async function callerTurn(text) {
    if (finished || !history) return;
    if (pendingEnd?.outcome === "failed") return; // the agent is down
    clearTimeout(silenceTimer);
    silenceStage = 0;
    callerSpoke = true;
    const continued = Boolean(pendingEnd) || endInterrupted;
    if (pendingEnd) {
      // The caller spoke over the goodbye: stay on the line.
      clearTimeout(endTimer);
      pendingEnd = null;
    }
    endInterrupted = false;
    history.push({
      role: "user",
      content: continued ? `${STILL_LIVE_NOTE} ${text}` : text,
    });
    transcript.push({ role: "caller", text });

    if (wrapUp) {
      sayFixed(WRAP_UP_LINE);
      scheduleEnd("lead", WRAP_UP_LINE);
      return;
    }

    const controller = new AbortController();
    current = controller;
    let streamed = false;
    const result = await agent.runTurn(history, {
      signal: controller.signal,
      onText: (token) => {
        if (finished || controller.signal.aborted) return;
        streamed = true;
        safeSend({ type: "text", token, last: false });
      },
    });
    if (current === controller) current = null;
    history = result.history;
    // The latest lookup wins: a corrected number that matched nobody clears
    // a carrier the caller has just said is not theirs.
    if (result.lookedUp === "found") carrier = result.carrier;
    else if (result.lookedUp === "no_match") carrier = null;
    if (result.spoken) transcript.push({ role: "agent", text: result.spoken });
    // Interrupted or superseded: Twilio has already stopped speaking, and
    // whatever comes next is queued behind this.
    if (finished || controller.signal.aborted) return;

    if (result.failed) {
      if (streamed) safeSend({ type: "text", token: " ", last: false });
      sayFixed(FALLBACK_LINE);
      scheduleEnd("failed", FALLBACK_LINE);
      return;
    }
    safeSend({ type: "text", token: "", last: true });
    if (result.end)
      scheduleEnd(
        result.end.outcome,
        result.spoken,
        result.end.callbackPromise,
      );
    else startSilenceTimer(result.spoken);
  }

  // Rewrites the last thing the agent said to what the caller actually heard.
  function applyInterrupt(heard) {
    if (finished || !history) return;
    const lastSpoken = transcript.findLast((entry) => entry.role === "agent");
    if (lastSpoken) lastSpoken.text = heard;
    const index = history.findLastIndex((m) => m.role === "assistant");
    if (index < 0) return;
    const message = history[index];
    if (typeof message.content === "string") {
      message.content = heardPart(message.content, heard) || message.content;
      return;
    }
    const block = message.content.findLast((b) => b.type === "text");
    if (!block) return;
    const kept = heardPart(block.text, heard);
    const content = kept
      ? message.content.map((b) => (b === block ? { ...b, text: kept } : b))
      : message.content.filter((b) => b !== block);
    if (content.length) history[index] = { ...message, content };
    else history.splice(index, 1);
  }

  function onInterrupt(heard) {
    if (finished) return queue;
    current?.abort();
    if (pendingEnd && pendingEnd.outcome !== "failed") {
      clearTimeout(endTimer);
      pendingEnd = null;
      endInterrupted = true;
    }
    return enqueue(() => {
      applyInterrupt(heard);
      if (!finished && !pendingEnd) startSilenceTimer("");
    });
  }

  function onDigit(digit) {
    if (finished || !history) return queue;
    clearTimeout(dtmfTimer);
    clearTimeout(silenceTimer);
    const submit = () => {
      const digits = dtmf;
      dtmf = "";
      if (!digits) return queue;
      current?.abort();
      return enqueue(() => callerTurn(`(keyed in) ${digits}`));
    };
    if (digit === "#") {
      if (dtmf) return submit();
    } else if (digit === "*") dtmf = "";
    else if (/^\d$/.test(digit)) dtmf += digit;
    if (dtmf) dtmfTimer = setTimeout(submit, DTMF_PAUSE_MS);
    // A stray key with nothing to submit must not leave the call unwatched.
    else if (!current && !pendingEnd) startSilenceTimer("");
    return queue;
  }

  function onSetup() {
    if (history || finished) return queue;
    const at = new Date(now());
    history = [
      {
        role: "user",
        content: callContext({
          fromKnown: Boolean(callableNumber(context.from)),
          open: isOpen(at, config.hours),
          hours: config.hours,
          now: at,
        }),
      },
      { role: "assistant", content: GREETING },
    ];
    transcript.push({ role: "agent", text: GREETING });
    Promise.resolve()
      .then(() => agent.prewarm())
      .catch(() => {});
    startSilenceTimer(GREETING);
    maxTimer = setTimeout(() => {
      wrapUp = true;
    }, config.maxCallSeconds * 1000);
    return queue;
  }

  // Takes one parsed message from Twilio. The returned promise settles when
  // the message has been fully handled.
  function handle(message) {
    if (!message || typeof message !== "object" || finished) return queue;
    switch (message.type) {
      case "setup":
        return onSetup();
      case "prompt":
        if (!history) return queue;
        // A partial transcript is not a turn, but it does mean the caller is
        // talking: hold the "are you still there?" check while they are.
        if (message.last !== true) {
          if (!current && !pendingEnd) {
            silenceStage = 0;
            startSilenceTimer("");
          }
          return queue;
        }
        if (
          typeof message.voicePrompt !== "string" ||
          !message.voicePrompt.trim()
        )
          return queue;
        current?.abort();
        return enqueue(() => callerTurn(message.voicePrompt.trim()));
      case "dtmf":
        return onDigit(String(message.digit ?? ""));
      case "interrupt":
        return onInterrupt(
          typeof message.utteranceUntilInterrupt === "string"
            ? message.utteranceUntilInterrupt.trim()
            : "",
        );
      case "error":
        console.error("ConversationRelay error:", message.description);
        return queue;
      default:
        return queue;
    }
  }

  // The socket closed, for any reason. Lets a turn that is being aborted
  // settle first, so its part of the transcript is not lost.
  function closed() {
    if (finished) return queue;
    current?.abort();
    for (const timer of [silenceTimer, endTimer, dtmfTimer, maxTimer])
      clearTimeout(timer);
    return enqueue(() =>
      finish(
        pendingEnd?.outcome || (callerSpoke ? "lead" : "abandoned"),
        pendingEnd?.callbackPromise,
      ),
    );
  }

  return { handle, closed };
}

module.exports = { createSession, speakMs };
