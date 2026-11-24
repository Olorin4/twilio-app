jest.mock("../../src/token", () => ({
  callerId: "+15550000001",
  getIdentity: () => "operator",
}));
jest.mock("../../src/db", () => ({ query: jest.fn() }));
jest.mock("../../src/receptionist/store", () => ({
  startCall: jest.fn(),
  finishCall: jest.fn(),
}));
jest.mock("../../src/receptionist/routing", () => ({
  decideRoute: jest.fn(),
  resolveProfile: jest.fn(),
}));
jest.mock("../../src/providerContext", () => ({
  getProviderForWebhook: jest.fn(),
}));

const store = require("../../src/receptionist/store");
const {
  decideRoute,
  resolveProfile,
} = require("../../src/receptionist/routing");
const { getProviderForWebhook } = require("../../src/providerContext");
const { getConfig } = require("../../src/receptionist/config");
const tokens = require("../../src/receptionist/tokens");
const twimlModule = require("../../src/receptionist/twiml");
const { relayTwiml, agentTwiml, endedHandler } = twimlModule;
const { voiceResponse } = require("../../src/callResponse");
const { isTwilioWebhook } = require("../../src/security");

const sid = `CA${"1".repeat(32)}`;
const ws = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000002";
const body = { CallSid: sid, From: "+15551230009", To: "+15550000001" };
const { JACK } = require("../../src/receptionist/seed/jack");
const jackId = "00000000-0000-4000-8000-0000000000a1";
const jack = {
  ...JACK,
  id: jackId,
  workspaceId: ws,
  isDefault: true,
  enabled: true,
  voice: null,
};
const kelevo = "00000000-0000-4000-8000-000000000003";
const supportId = "00000000-0000-4000-8000-0000000000c3";
const support = {
  id: supportId,
  workspaceId: kelevo,
  kind: "support",
  name: "Support",
  personaName: "Sam",
  companyName: "KelevoTMS",
  greeting: "Thanks for calling KelevoTMS support. This is Sam.",
  voice: "kelevoVoice123",
  enabled: true,
  isDefault: false,
  dailyLimit: 20,
};

function response() {
  return {
    type: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    sendStatus: jest.fn().mockReturnThis(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.TWILIO_WEBHOOK_BASE_URL = "https://example.test";
  process.env.RECEPTIONIST_ENABLED = "true";
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
  resolveProfile.mockResolvedValue(jack);
});
afterEach(() => {
  delete process.env.TWILIO_WEBHOOK_BASE_URL;
  delete process.env.RECEPTIONIST_ENABLED;
  delete process.env.RECEPTIONIST_SAY_VOICE;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("relayTwiml", () => {
  test("carries the token as a Parameter, never in the URL", () => {
    const xml = relayTwiml({
      token: "tok123",
      config: getConfig({}),
      baseUrl: "https://example.test",
      profile: jack,
    });
    expect(xml).toContain('url="wss://example.test/receptionist/ws"');
    expect(xml).toContain('action="https://example.test/receptionist/ended"');
    expect(xml).toContain('<Parameter name="token" value="tok123"/>');
    expect(xml).toContain('voice="7EzWGsX10sAS4c9m9cPf"');
    expect(xml).toContain('ttsProvider="ElevenLabs"');
    expect(xml).toContain('welcomeGreetingInterruptible="none"');
    expect(xml).toContain('dtmfDetection="true"');
    // Partial transcripts tell the session the caller is still talking.
    expect(xml).toContain('partialPrompts="true"');
    expect(xml).not.toMatch(/wss:[^"]*tok123/);
  });

  test("the greeting names Jack and says nothing about AI or transcription", () => {
    // The owner's decision: Jack says he is an AI when a caller asks, not in
    // the welcome message. The relay speaks the profile's greeting; there is
    // no hard-coded copy left in twiml.js.
    const GREETING = JACK.greeting;
    expect(twimlModule.GREETING).toBeUndefined();
    expect(GREETING).toBe(
      "Thanks for calling Iron Wing Dispatching. This is Jack. How can I help you today?",
    );
    expect(GREETING).not.toMatch(/\bAI\b|assistant|transcribed|recorded/i);
    // The line takes every kind of business call, so the opener is general.
    expect(GREETING).toMatch(/How can I help you today\?$/);
    expect(GREETING).not.toContain("for your truck");
    const xml = relayTwiml({
      token: "t",
      config: getConfig({}),
      baseUrl: "https://example.test/",
      profile: jack,
    });
    expect(xml).toContain("This is Jack. How can I help you today?");
  });

  test("the relay uses the profile's greeting and voice", () => {
    const xml = relayTwiml({
      token: "t",
      config: getConfig({}),
      baseUrl: "https://example.test",
      profile: support,
    });
    expect(xml).toContain(`welcomeGreeting="${support.greeting}"`);
    expect(xml).toContain('voice="kelevoVoice123"');
    expect(xml).not.toContain("Iron Wing");
    // A profile without a voice uses the configured one.
    const fallback = relayTwiml({
      token: "t",
      config: getConfig({}),
      baseUrl: "https://example.test",
      profile: { ...support, voice: null },
    });
    expect(fallback).toContain(`voice="${getConfig({}).voice}"`);
  });

  test("connection calls use the connection-scoped paths", () => {
    const xml = relayTwiml({
      token: "t",
      connectionId: id,
      config: getConfig({}),
      baseUrl: "https://example.test",
      profile: jack,
    });
    expect(xml).toContain(
      `url="wss://example.test/webhooks/${id}/receptionist/ws"`,
    );
    expect(xml).toContain(
      `action="https://example.test/webhooks/${id}/receptionist/ended"`,
    );
  });
});

describe("tokens", () => {
  test("a token returns its context once", () => {
    const context = { callSid: sid, workspaceId: ws, from: "+15551230009" };
    const t = tokens.mint(context);
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokens.consume(t, sid)).toEqual(context);
    expect(tokens.consume(t, sid)).toBeNull();
  });

  test("tokens are single use and bound to the call", () => {
    const t = tokens.mint({ callSid: sid, workspaceId: ws, from: "x" });
    expect(tokens.consume(t, `CA${"2".repeat(32)}`)).toBeNull();
    expect(tokens.consume(t, sid)).toBeNull(); // burned by the failed attempt
  });

  test("tokens expire after 60 seconds", () => {
    jest.useFakeTimers();
    const t = tokens.mint({ callSid: sid, workspaceId: ws, from: "x" });
    jest.advanceTimersByTime(61_000);
    expect(tokens.consume(t, sid)).toBeNull();
  });

  test("an unknown or malformed token is refused", () => {
    expect(tokens.consume("nope", sid)).toBeNull();
    expect(tokens.consume(undefined, sid)).toBeNull();
  });
});

describe("agentTwiml", () => {
  test("an agent call records its start and returns ConversationRelay with a live token", async () => {
    decideRoute.mockResolvedValue({ agent: true, reason: "ok" });
    const xml = await agentTwiml({ body });
    expect(xml).toContain("<ConversationRelay");
    expect(resolveProfile).toHaveBeenCalledWith(undefined);
    expect(decideRoute).toHaveBeenCalledWith(
      expect.objectContaining({ profile: jack }),
    );
    expect(store.startCall).toHaveBeenCalledWith({
      callSid: sid,
      workspaceId: ws,
      connectionId: null,
      from: "+15551230009",
      agentProfileId: jackId,
    });
    const token = /name="token" value="([^"]+)"/.exec(xml)[1];
    expect(tokens.consume(token, sid)).toEqual({
      callSid: sid,
      workspaceId: ws,
      connectionId: null,
      from: "+15551230009",
      agentProfileId: jackId,
    });
    expect(xml).toContain(`welcomeGreeting="${JACK.greeting}"`);
  });

  test("the token context carries the profile and its workspace", async () => {
    decideRoute.mockResolvedValue({ agent: true, reason: "ok" });
    resolveProfile.mockResolvedValue(support);
    const provider = {
      id,
      workspaceId: kelevo,
      phoneNumber: body.To,
      handler: "ai_agent",
      agentProfileId: supportId,
    };
    const xml = await agentTwiml({
      body,
      provider,
      connection: { id, workspaceId: kelevo },
    });
    expect(resolveProfile).toHaveBeenCalledWith(provider);
    const context = {
      callSid: sid,
      workspaceId: kelevo,
      connectionId: id,
      from: "+15551230009",
      agentProfileId: supportId,
    };
    expect(store.startCall).toHaveBeenCalledWith(context);
    const token = /name="token" value="([^"]+)"/.exec(xml)[1];
    expect(tokens.consume(token, sid)).toEqual(context);
    expect(context.workspaceId).not.toBe(ws);
    expect(xml).toContain(`welcomeGreeting="${support.greeting}"`);
  });

  test("a call with no profile is routed with none and gets null", async () => {
    resolveProfile.mockResolvedValue(null);
    decideRoute.mockResolvedValue({ agent: false, reason: "no_agent" });
    expect(await agentTwiml({ body })).toBeNull();
    expect(decideRoute).toHaveBeenCalledWith(
      expect.objectContaining({ profile: null }),
    );
    expect(store.startCall).not.toHaveBeenCalled();
  });

  test("a failed profile lookup falls back", async () => {
    resolveProfile.mockRejectedValue(new Error("database down"));
    decideRoute.mockResolvedValue({ agent: true, reason: "ok" });
    expect(await agentTwiml({ body })).toBeNull();
    expect(store.startCall).not.toHaveBeenCalled();
  });

  test("a connection call is scoped to its connection", async () => {
    decideRoute.mockResolvedValue({ agent: true, reason: "ok" });
    const provider = { id, workspaceId: ws, phoneNumber: body.To };
    const xml = await agentTwiml({
      body,
      provider,
      connection: { id, workspaceId: ws },
    });
    expect(decideRoute).toHaveBeenCalledWith(
      expect.objectContaining({ from: body.From, to: body.To, provider }),
    );
    expect(xml).toContain(`/webhooks/${id}/receptionist/ws`);
    expect(store.startCall).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: id }),
    );
  });

  test("a blocked caller ID is recorded as anonymous", async () => {
    decideRoute.mockResolvedValue({ agent: true, reason: "ok" });
    await agentTwiml({ body: { ...body, From: undefined } });
    expect(store.startCall).toHaveBeenCalledWith(
      expect.objectContaining({ from: "anonymous" }),
    );
  });

  test("a call the agent should not take returns null", async () => {
    decideRoute.mockResolvedValue({ agent: false, reason: "contact" });
    expect(await agentTwiml({ body })).toBeNull();
    expect(store.startCall).not.toHaveBeenCalled();
  });

  test("with the feature off nothing is looked up", async () => {
    delete process.env.RECEPTIONIST_ENABLED;
    expect(await agentTwiml({ body })).toBeNull();
    expect(decideRoute).not.toHaveBeenCalled();
    expect(resolveProfile).not.toHaveBeenCalled();
  });

  test("any failure returns null so the call follows today's path", async () => {
    decideRoute.mockRejectedValue(new Error("database down"));
    expect(await agentTwiml({ body })).toBeNull();
    decideRoute.mockResolvedValue({ agent: true, reason: "ok" });
    store.startCall.mockRejectedValueOnce(new Error("table missing"));
    expect(await agentTwiml({ body })).toBeNull();
  });

  test("without a public base URL the agent cannot be reached, so null", async () => {
    delete process.env.TWILIO_WEBHOOK_BASE_URL;
    decideRoute.mockResolvedValue({ agent: true, reason: "ok" });
    expect(await agentTwiml({ body })).toBeNull();
  });
});

describe("endedHandler", () => {
  test("a failed session falls back to today's TwiML and leaves the row to finalize", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-11-16T15:00:00Z"));
    const res = response();
    await endedHandler({ body: { ...body, SessionStatus: "failed" } }, res);
    expect(res.send.mock.calls[0][0]).toBe(voiceResponse(body));
    expect(res.send.mock.calls[0][0]).toMatch(
      /<Dial[^>]*>.*operator<\/Client>/,
    );
    expect(store.finishCall).not.toHaveBeenCalled();
  });

  test("a failed connection session falls back with that connection's provider", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-11-16T15:00:00Z"));
    const provider = { id, workspaceId: ws, phoneNumber: body.To };
    getProviderForWebhook.mockResolvedValue(provider);
    const res = response();
    const connection = { id, workspaceId: ws };
    await endedHandler(
      {
        body: { ...body, SessionStatus: "failed" },
        providerConnection: connection,
      },
      res,
    );
    expect(getProviderForWebhook).toHaveBeenCalledWith(connection, body.To);
    expect(res.send.mock.calls[0][0]).toBe(voiceResponse(body, provider));
  });

  test("if the fallback itself fails the caller still hears something", async () => {
    getProviderForWebhook.mockRejectedValue(new Error("no number"));
    const res = response();
    await endedHandler(
      {
        body: { ...body, SessionStatus: "failed" },
        providerConnection: { id, workspaceId: ws },
      },
      res,
    );
    expect(res.send.mock.calls[0][0]).toContain("<Say");
    expect(res.send.mock.calls[0][0]).toContain("call you back");
  });

  test("the ended fallback names no other business", async () => {
    const other = "00000000-0000-4000-8000-0000000000ff";
    getProviderForWebhook.mockRejectedValue(new Error("no number"));
    const failed = { ...body, SessionStatus: "failed" };
    let res = response();
    await endedHandler(
      { body: failed, providerConnection: { id, workspaceId: other } },
      res,
    );
    let twiml = res.send.mock.calls[0][0];
    expect(twiml).toContain(
      "Thank you for calling. Someone will call you back soon.",
    );
    expect(twiml).not.toMatch(/Iron Wing/);

    // The provider was found but the softphone TwiML itself failed.
    getProviderForWebhook.mockResolvedValue({
      id,
      workspaceId: other,
      phoneNumber: body.To,
    });
    const callResponse = require("../../src/callResponse");
    const spy = jest
      .spyOn(callResponse, "voiceResponse")
      .mockImplementation(() => {
        throw new Error("bad provider");
      });
    res = response();
    await endedHandler(
      { body: failed, providerConnection: { id, workspaceId: other } },
      res,
    );
    twiml = res.send.mock.calls[0][0];
    expect(twiml).toContain(
      "Thank you for calling. Someone will call you back soon.",
    );
    expect(twiml).not.toMatch(/Iron Wing/);

    // Iron Wing keeps today's line, on its connection and on the legacy path.
    getProviderForWebhook.mockResolvedValue({
      id,
      workspaceId: ws,
      phoneNumber: body.To,
    });
    for (const req of [
      { body: failed, providerConnection: { id, workspaceId: ws } },
      { body: failed },
    ]) {
      res = response();
      await endedHandler(req, res);
      expect(res.send.mock.calls[0][0]).toContain(
        "Thank you for calling Iron Wing Dispatching. One of our representatives will call you back soon.",
      );
    }
    spy.mockRestore();
  });

  test("a failed session rings the line's people", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-11-16T15:00:00Z"));
    const pool = require("../../src/db");
    const person = "00000000-0000-4000-8000-0000000000e1";
    const provider = {
      id,
      numberId: "00000000-0000-4000-8000-0000000000e2",
      workspaceId: ws,
      phoneNumber: body.To,
    };
    getProviderForWebhook.mockResolvedValue(provider);
    pool.query.mockResolvedValueOnce({ rows: [{ id: person }] });
    let res = response();
    await endedHandler(
      {
        body: { ...body, SessionStatus: "failed" },
        providerConnection: { id, workspaceId: ws },
      },
      res,
    );
    expect(res.send.mock.calls[0][0]).toContain(
      `<Identity>u${person.replace(/-/g, "")}_c${id.replace(/-/g, "")}</Identity>`,
    );
    // The legacy route rings the owners on the legacy number.
    pool.query.mockResolvedValueOnce({ rows: [{ id: person }] });
    res = response();
    await endedHandler({ body: { ...body, SessionStatus: "failed" } }, res);
    expect(res.send.mock.calls[0][0]).toContain(
      `>u${person.replace(/-/g, "")}_legacy</Client>`,
    );
  });

  test.each(["ended", "completed"])("a session that %s hangs up", async (s) => {
    const res = response();
    await endedHandler({ body: { CallSid: sid, SessionStatus: s } }, res);
    expect(res.type).toHaveBeenCalledWith("text/xml");
    expect(res.send.mock.calls[0][0]).toContain("<Hangup/>");
  });
});

describe("announcement voice", () => {
  const closedCallBody = { To: "+15550000001" };
  test("the announcements use the configured voice only when one is set", () => {
    delete process.env.TWILIO_WEBHOOK_BASE_URL;
    jest.useFakeTimers().setSystemTime(new Date("2026-11-16T05:00:00Z"));
    expect(voiceResponse(closedCallBody)).toContain("<Say>Hello!");
    process.env.RECEPTIONIST_SAY_VOICE = "Polly.Joanna-Neural";
    expect(voiceResponse(closedCallBody)).toContain(
      '<Say voice="Polly.Joanna-Neural">Hello!',
    );
  });
});

describe("login bypass", () => {
  const post = (path) => ({ method: "POST", path });
  test.each([
    "/voice",
    "/sms",
    "/sms-status",
    "/call-status",
    "/announcement/missed",
    "/announcement/closed/complete",
    `/webhooks/${id}/voice`,
    `/webhooks/${id}/announcement/missed/complete`,
    "/receptionist/ended",
    `/webhooks/${id}/receptionist/ended`,
  ])("%s is a Twilio webhook", (path) => {
    expect(isTwilioWebhook(post(path))).toBe(true);
  });
  test.each([
    ["GET", "/voice"],
    ["POST", "/leads"],
    ["POST", "/receptionist/ws"],
    ["POST", "/receptionist/ended/extra"],
    ["POST", "/webhooks/not-a-uuid/receptionist/ended"],
    ["POST", "/messages"],
  ])("%s %s still needs a login", (method, path) => {
    expect(isTwilioWebhook({ method, path })).toBe(false);
  });
});

describe("agentTwiml under a slow database", () => {
  test("a routing decision that hangs gives the call today's path within two seconds", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
    decideRoute.mockReturnValue(new Promise(() => {}));
    const pending = agentTwiml({ body });
    await jest.advanceTimersByTimeAsync(1999);
    let settled = false;
    pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(2);
    expect(await pending).toBeNull();
    expect(store.startCall).not.toHaveBeenCalled();
  });

  test("a profile lookup slower than the deadline falls back within it", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
    resolveProfile.mockReturnValue(new Promise(() => {}));
    decideRoute.mockResolvedValue({ agent: true, reason: "ok" });
    const pending = agentTwiml({ body });
    await jest.advanceTimersByTimeAsync(2001);
    expect(await pending).toBeNull();
    expect(decideRoute).not.toHaveBeenCalled();
    expect(store.startCall).not.toHaveBeenCalled();
  });

  test("a call record that lands after the deadline is discarded, not left as a phantom", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
    decideRoute.mockResolvedValue({ agent: true, reason: "ok" });
    let finishInsert;
    store.startCall.mockReturnValue(
      new Promise((resolve) => (finishInsert = resolve)),
    );
    store.discardCall = jest.fn().mockResolvedValue();
    const pending = agentTwiml({ body });
    await jest.advanceTimersByTimeAsync(2001);
    expect(await pending).toBeNull();
    finishInsert();
    await jest.advanceTimersByTimeAsync(0);
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.discardCall).toHaveBeenCalledWith(sid);
  });
});
