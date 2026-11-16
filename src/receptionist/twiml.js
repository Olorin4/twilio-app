/* TwiML for the AI receptionist: the hand-off to ConversationRelay, and the
<Connect action> handler Twilio calls when the session is over. */

const {
  twiml: { VoiceResponse },
} = require("twilio");
const { getConfig, sayOptions } = require("./config");
const { decideRoute } = require("./routing");
const store = require("./store");
const tokens = require("./tokens");
const { IRON_WING_WORKSPACE_ID } = require("../workspaceContext");

const GREETING =
  "Thanks for calling Iron Wing Dispatching. This is Jack, the AI assistant here, and this call is transcribed so our dispatcher can follow up. Are you looking for dispatch for your truck?";

const callSidPattern = /^CA[0-9a-f]{32}$/i;

function relayTwiml({ token, connectionId, config, baseUrl }) {
  const base = baseUrl.replace(/\/$/, "");
  const prefix = connectionId ? `/webhooks/${connectionId}` : "";
  const response = new VoiceResponse();
  const relay = response
    .connect({ action: `${base}${prefix}/receptionist/ended` })
    .conversationRelay({
      url: `${base.replace(/^http/i, "ws")}${prefix}/receptionist/ws`,
      welcomeGreeting: GREETING,
      // The greeting carries the AI and transcription notice, so the caller
      // cannot talk over it.
      welcomeGreetingInterruptible: "none",
      ttsProvider: "ElevenLabs",
      voice: config.voice,
      language: "en-US",
      dtmfDetection: true,
      interruptible: "any",
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
  try {
    const config = getConfig();
    if (!config.enabled) return null;
    const baseUrl = process.env.TWILIO_WEBHOOK_BASE_URL;
    if (!baseUrl || !callSidPattern.test(body?.CallSid || "")) return null;
    const route = await decideRoute({
      from: body.From,
      to: body.To,
      provider,
      config,
    });
    if (!route.agent) return null;
    const context = {
      callSid: body.CallSid,
      workspaceId: IRON_WING_WORKSPACE_ID,
      connectionId: connection?.id || null,
      from:
        typeof body.From === "string" && body.From ? body.From : "anonymous",
    };
    await store.startCall(context);
    return relayTwiml({
      token: tokens.mint(context),
      connectionId: context.connectionId,
      config,
      baseUrl,
    });
  } catch (error) {
    console.error("Receptionist routing failed:", error.message);
    return null;
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
  try {
    // Required lazily: callResponse loads the Twilio credentials module.
    const { voiceResponse } = require("../callResponse");
    const provider = req.providerConnection
      ? await require("../providerContext").getProviderForWebhook(
          req.providerConnection,
          req.body.To,
        )
      : undefined;
    return res.send(voiceResponse(req.body, provider));
  } catch (error) {
    console.error("Receptionist fallback failed:", error.message);
    const response = new VoiceResponse();
    response.say(
      sayOptions(),
      "Thank you for calling Iron Wing Dispatching. One of our representatives will call you back soon.",
    );
    response.hangup();
    return res.send(response.toString());
  }
}

module.exports = { GREETING, relayTwiml, agentTwiml, endedHandler };
