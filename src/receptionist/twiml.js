/* TwiML for the AI receptionist: the hand-off to ConversationRelay, and the
<Connect action> handler Twilio calls when the session is over. */

const {
  twiml: { VoiceResponse },
} = require("twilio");
const { getConfig, sayOptions } = require("./config");
const { decideRoute, resolveProfile } = require("./routing");
const store = require("./store");
const tokens = require("./tokens");
const { IRON_WING_WORKSPACE_ID } = require("../workspaceContext");

// Jack's greeting. The relay and the session use the answering profile's
// greeting; this stays only for the simulator script until it moves to
// profiles too.
const GREETING =
  "Thanks for calling Iron Wing Dispatching. This is Jack. How can I help you today?";

const callSidPattern = /^CA[0-9a-f]{32}$/i;
// Twilio is waiting for TwiML while the routing decision reads the database.
// Past this, the call follows today's path instead of waiting on a slow one.
const DECISION_DEADLINE_MS = 2000;

// `profile` is the agent answering: its greeting is the welcome message and
// its voice, when set, replaces the configured one.
function relayTwiml({ token, connectionId, config, baseUrl, profile }) {
  const base = baseUrl.replace(/\/$/, "");
  const prefix = connectionId ? `/webhooks/${connectionId}` : "";
  const response = new VoiceResponse();
  const relay = response
    .connect({ action: `${base}${prefix}/receptionist/ended` })
    .conversationRelay({
      url: `${base.replace(/^http/i, "ws")}${prefix}/receptionist/ws`,
      welcomeGreeting: profile.greeting,
      // The greeting carries the AI and transcription notice, so the caller
      // cannot talk over it.
      welcomeGreetingInterruptible: "none",
      ttsProvider: "ElevenLabs",
      voice: profile.voice || config.voice,
      language: "en-US",
      dtmfDetection: true,
      interruptible: "any",
      // Partial transcripts tell the session the caller is still talking, so
      // it does not ask "are you still there?" over a long answer.
      partialPrompts: true,
    });
  // The token travels as a parameter, which Twilio delivers inside the
  // WebSocket setup message, never in the URL.
  relay.parameter({ name: "token", value: token });
  return response.toString();
}

// TwiML handing this call to the agent, or null when the call should follow
// today's path. Never throws: a caller must not get an error because of this
// feature.
async function agentTwiml({ body, provider, connection }) {
  let config;
  try {
    config = getConfig();
  } catch (error) {
    console.error("Receptionist settings failed:", error.message);
    return null;
  }
  if (!config.enabled) return null;
  const baseUrl = process.env.TWILIO_WEBHOOK_BASE_URL;
  if (!baseUrl || !callSidPattern.test(body?.CallSid || "")) return null;

  let expired = false;
  let timer;
  // The profile lookup runs inside the deadline too: a slow or failing read
  // sends the call down today's path.
  const decide = (async () => {
    const profile = await resolveProfile(provider);
    if (expired) return null;
    const route = await decideRoute({
      from: body.From,
      to: body.To,
      provider,
      config,
      profile,
    });
    if (!route.agent || expired) return null;
    const context = {
      callSid: body.CallSid,
      workspaceId: profile.workspaceId,
      connectionId: connection?.id || null,
      from:
        typeof body.From === "string" && body.From ? body.From : "anonymous",
      agentProfileId: profile.id,
    };
    await store.startCall(context);
    if (expired) {
      // The call has already gone down today's path; do not leave a record
      // of an agent call that never happened.
      await store.discardCall(context.callSid);
      return null;
    }
    return relayTwiml({
      token: tokens.mint(context),
      connectionId: context.connectionId,
      config,
      baseUrl,
      profile,
    });
  })().catch((error) => {
    console.error("Receptionist routing failed:", error.message);
    return null;
  });
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      console.error("Receptionist routing timed out; using the usual path.");
      resolve(null);
    }, DECISION_DEADLINE_MS);
  });
  try {
    return await Promise.race([decide, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// Twilio requests this when <Connect> ends. A session that ended normally is
// hung up. One that failed (the agent could not start, or dropped) falls back
// to today's behaviour so the caller is never left with nothing. This handler
// does not write to the store: the session's own after-call step owns the
// row, and a write here would race it and lose the transcript.
async function endedHandler(req, res) {
  const status = req.body?.SessionStatus;
  res.type("text/xml");
  if (status === "ended" || status === "completed") {
    const response = new VoiceResponse();
    response.hangup();
    return res.send(response.toString());
  }
  console.error(
    "Receptionist session failed:",
    req.body?.ErrorCode || "unknown error",
  );
  let provider;
  try {
    // Required lazily: callResponse loads the Twilio credentials module.
    const { voiceResponse } = require("../callResponse");
    provider = req.providerConnection
      ? await require("../providerContext").getProviderForWebhook(
          req.providerConnection,
          req.body.To,
        )
      : undefined;
    return res.send(voiceResponse(req.body, provider));
  } catch (error) {
    console.error("Receptionist fallback failed:", error.message);
    // Only Iron Wing's own calls (the legacy route has no connection) may
    // hear its name; any other business's caller hears a line naming none.
    const workspaceId =
      provider?.workspaceId ?? req.providerConnection?.workspaceId;
    const ironWing = !workspaceId || workspaceId === IRON_WING_WORKSPACE_ID;
    const response = new VoiceResponse();
    response.say(
      sayOptions(),
      ironWing
        ? "Thank you for calling Iron Wing Dispatching. One of our representatives will call you back soon."
        : "Thank you for calling. Someone will call you back soon.",
    );
    response.hangup();
    return res.send(response.toString());
  }
}

module.exports = { GREETING, relayTwiml, agentTwiml, endedHandler };
