/* One turn of the live conversation: send the history to Claude, stream the
reply to the caller as it arrives, and run the agent's two tools.

Two things here exist because of how current Claude models behave:
- Words a model writes just before a tool call can come back hidden instead
  of as text. So the "one second" line during a lookup is spoken by this
  code, and the goodbye travels as an end_call input, which always arrives
  intact.
- Thinking blocks are tied to the exact history that produced them. The
  session trims history when a caller interrupts, so thinking blocks are kept
  only while a tool round is in flight and dropped from the history we keep. */

const { buildSystem, TOOLS } = require("./prompt");
const { lookupCarrier, parseDocket, speakDigits } = require("./carrierLookup");
const { addUsage } = require("./costs");

const LOOKUP_FILLER = "One second while I pull that up.";

// The prompt tells the model to put its closing words in end_call's goodbye
// and not to write them as text too. It sometimes does both, and the caller
// would then hear the callback promise twice. A goodbye whose words were
// mostly spoken already in the same reply is dropped; one that adds something
// new (a promise after "I have Smith Trucking in Dallas") is still spoken.
const words = (text) => text.toLowerCase().match(/[a-z0-9']{4,}/g) || [];
function alreadySaid(goodbye, spoken) {
  const wanted = words(goodbye);
  if (!wanted.length || !spoken.trim()) return false;
  const heard = new Set(words(spoken));
  const repeated = wanted.filter((word) => heard.has(word)).length;
  return repeated / wanted.length > 0.5;
}
const MAX_REQUESTS_PER_TURN = 4;
// A request is given up on when the stream goes quiet for this long, or when
// it has run this long in total. Either way the caller hears the fallback
// line instead of dead air.
const STREAM_QUIET_MS = 6000;
const REQUEST_LIMIT_MS = 20_000;
const OUTCOMES = ["lead", "not_a_lead", "spam"];
const STALLED = Symbol("stalled");

const isOpus = (model) => model.startsWith("claude-opus");
const isSonnet = (model) => model.startsWith("claude-sonnet");
const isHaiku = (model) => model.startsWith("claude-haiku");

// The request fields that depend on the configured model.
function requestParams(config) {
  const model = config.liveModel;
  const params = {
    model,
    max_tokens: 4096,
    output_config: { effort: config.liveEffort },
    system: buildSystem(),
    tools: TOOLS,
  };
  if (config.liveThinking === "off") {
    // Opus cannot run without thinking; lower effort is its only control.
    if (isSonnet(model)) params.thinking = { type: "between_tools" };
    else if (isHaiku(model)) params.thinking = { type: "disabled" };
  }
  if (config.liveSpeed === "fast" && isOpus(model)) params.speed = "fast";
  if (isOpus(model) || isSonnet(model)) {
    // If the model declines a turn, the API retries it on a fallback model.
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  return params;
}

// What the SDK has seen so far of a reply that did not finish.
function unfinished(stream) {
  try {
    return stream?.currentMessage;
  } catch {
    return undefined;
  }
}

const withoutThinking = (messages) =>
  messages
    .map((message) =>
      Array.isArray(message.content)
        ? {
            ...message,
            content: message.content.filter(
              (block) =>
                block.type !== "thinking" && block.type !== "redacted_thinking",
            ),
          }
        : message,
    )
    .filter(
      (message) => !Array.isArray(message.content) || message.content.length,
    );

function createAgent({ client, config, lookup = lookupCarrier }) {
  const params = requestParams(config);
  const surface = params.betas ? client.beta.messages : client.messages;
  // Tokens used by every request this agent makes, for the cost of the call.
  const usage = [];

  // Writes the prompt cache while the greeting plays, so the caller's first
  // turn does not pay for it. Best effort.
  async function prewarm() {
    try {
      // Same prompt, tools and settings as a live request, without the
      // refusal-fallback fields, which this endpoint does not take.
      const shared = { ...params };
      delete shared.betas;
      delete shared.fallbacks;
      const warmed = await client.messages.create({
        ...shared,
        max_tokens: 0,
        messages: [{ role: "user", content: "warm" }],
      });
      addUsage(usage, warmed);
    } catch {
      // A cold cache only costs a little latency on the first turn.
    }
  }

  // One model request. Resolves with the final message, or STALLED when the
  // stream went quiet or the request ran too long.
  async function request(messages, { onDelta, signal }) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort);
    let quiet;
    let limit;
    let stream;
    let message;
    try {
      stream = surface.stream(
        { ...params, messages },
        { signal: controller.signal },
      );
      const stalled = new Promise((resolve) => {
        const giveUp = () => resolve(STALLED);
        limit = setTimeout(giveUp, REQUEST_LIMIT_MS);
        const heard = () => {
          clearTimeout(quiet);
          quiet = setTimeout(giveUp, STREAM_QUIET_MS);
        };
        heard();
        // Any event counts as life: a reply that is only a tool call never
        // emits text, and one that has started speaking can still stall.
        stream.on("streamEvent", heard);
        stream.on("text", heard);
      });
      stream.on("text", onDelta);
      const final = stream.finalMessage();
      final.catch(() => {});
      message = await Promise.race([final, stalled]);
      return message;
    } finally {
      // A reply that was cut off or stalled never delivers its final usage,
      // but the prompt it had already read is billed all the same.
      addUsage(
        usage,
        message && message !== STALLED ? message : unfinished(stream),
      );
      clearTimeout(quiet);
      clearTimeout(limit);
      signal?.removeEventListener("abort", abort);
      controller.abort();
    }
  }

  async function runTool(tool, state, say) {
    if (tool.name === "lookup_carrier") {
      const docket = parseDocket(tool.input?.number);
      if (!docket.kind) return { found: false, reason: "not_a_number" };
      if (!state.requestText && !state.fillerSaid) say(LOOKUP_FILLER);
      state.fillerSaid = true;
      const result = await lookup(docket, {});
      // The latest lookup wins. A number that matched nobody replaces an
      // earlier match (the caller is correcting it); a lookup that merely
      // timed out says nothing either way.
      if (result.found) {
        state.carrier = result;
        state.lookedUp = "found";
      } else if (result.reason === "no_match") {
        state.carrier = null;
        state.lookedUp = "no_match";
      }
      return { ...result, spoken_number: speakDigits(docket.digits) };
    }
    if (tool.name === "end_call") {
      const { outcome, callback_promise, goodbye } = tool.input || {};
      if (!OUTCOMES.includes(outcome))
        return { error: `outcome must be one of ${OUTCOMES.join(", ")}` };
      if (
        typeof goodbye === "string" &&
        goodbye.trim() &&
        !alreadySaid(goodbye, state.requestText)
      )
        say(goodbye.trim());
      state.end = {
        outcome,
        callbackPromise:
          typeof callback_promise === "string" ? callback_promise : "",
      };
      return { ended: true };
    }
    return { error: `unknown tool ${tool.name}` };
  }

  async function runTurn(history, { onText = () => {}, signal } = {}) {
    let messages = [...history];
    const state = {
      spoken: "",
      requestText: "",
      fillerSaid: false,
      carrier: null,
      lookedUp: null,
      end: null,
    };
    // Everything said this turn is joined with single spaces for the record.
    const say = (text) => {
      state.spoken +=
        state.spoken && !/\s$/.test(state.spoken) ? ` ${text}` : text;
      onText(text);
    };
    const result = (failed) => ({
      history: withoutThinking(messages),
      spoken: state.spoken,
      end: state.end,
      carrier: state.carrier,
      // "found", "no_match", or null when this turn settled nothing.
      lookedUp: state.lookedUp,
      failed,
    });

    for (let count = 0; count < MAX_REQUESTS_PER_TURN; count++) {
      if (signal?.aborted) return result(false);
      state.requestText = "";
      state.fillerSaid = false;
      let message;
      try {
        message = await request(messages, {
          signal,
          onDelta: (delta) => {
            // The first delta of a later request follows earlier speech.
            const gap =
              !state.requestText && state.spoken && !/\s$/.test(state.spoken)
                ? " "
                : "";
            state.requestText += delta;
            state.spoken += gap + delta;
            onText(gap + delta);
          },
        });
      } catch (error) {
        if (signal?.aborted) {
          // Keep what the caller may have heard of the unfinished reply.
          if (state.requestText)
            messages.push({
              role: "assistant",
              content: [{ type: "text", text: state.requestText }],
            });
          return result(false);
        }
        console.error(
          "Receptionist model request failed:",
          error?.status || error?.name || "error",
        );
        return result(true);
      }
      if (message === STALLED) {
        console.error("Receptionist model request produced nothing in time.");
        return result(true);
      }
      if (
        message.stop_reason === "refusal" ||
        message.stop_reason === "max_tokens"
      ) {
        console.error("Receptionist model stopped:", message.stop_reason);
        return result(true);
      }

      messages.push({ role: "assistant", content: message.content });
      const tools = message.content.filter(
        (block) => block.type === "tool_use",
      );
      if (!tools.length) return result(false);

      const results = [];
      for (const tool of tools) {
        const output = await runTool(tool, state, say);
        results.push({
          type: "tool_result",
          tool_use_id: tool.id,
          content: JSON.stringify(output),
          ...(output.error ? { is_error: true } : {}),
        });
      }
      messages.push({ role: "user", content: results });
      if (state.end) return result(false);
    }
    console.error("Receptionist turn used too many model requests.");
    return result(true);
  }

  return {
    prewarm,
    runTurn,
    usage: () => usage.map((entry) => ({ ...entry })),
  };
}

module.exports = { createAgent, requestParams, LOOKUP_FILLER };
