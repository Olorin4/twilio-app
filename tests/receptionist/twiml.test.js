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
}));
jest.mock("../../src/providerContext", () => ({
  getProviderForWebhook: jest.fn(),
}));

const store = require("../../src/receptionist/store");
const { decideRoute } = require("../../src/receptionist/routing");
const { getProviderForWebhook } = require("../../src/providerContext");
const { getConfig } = require("../../src/receptionist/config");
const tokens = require("../../src/receptionist/tokens");
const {
  GREETING,
  relayTwiml,
  agentTwiml,
  endedHandler,
} = require("../../src/receptionist/twiml");
const { voiceResponse } = require("../../src/callResponse");
const { isTwilioWebhook } = require("../../src/security");

const sid = `CA${"1".repeat(32)}`;
const ws = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000002";
const body = { CallSid: sid, From: "+15551230009", To: "+15550000001" };

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
    });
    expect(xml).toContain('url="wss://example.test/receptionist/ws"');
    expect(xml).toContain('action="https://example.test/receptionist/ended"');
    expect(xml).toContain('<Parameter name="token" value="tok123"/>');
    expect(xml).toContain('voice="7EzWGsX10sAS4c9m9cPf"');
    expect(xml).toContain('ttsProvider="ElevenLabs"');
    expect(xml).toContain('welcomeGreetingInterruptible="none"');
    expect(xml).toContain('dtmfDetection="true"');
    expect(xml).not.toMatch(/wss:[^"]*tok123/);
  });

  test("the greeting names Jack as an AI assistant and says the call is transcribed", () => {
    expect(GREETING).toContain("Jack, the AI assistant");
    expect(GREETING).toContain("transcribed");
    const xml = relayTwiml({
      token: "t",
      config: getConfig({}),
      baseUrl: "https://example.test/",
    });
    expect(xml).toContain("Jack, the AI assistant");
  });

  test("connection calls use the connection-scoped paths", () => {
    const xml = relayTwiml({
      token: "t",
      connectionId: id,
      config: getConfig({}),
      baseUrl: "https://example.test",
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
    expect(store.startCall).toHaveBeenCalledWith({
      callSid: sid,
      workspaceId: ws,
      connectionId: null,
      from: "+15551230009",
    });
    const token = /name="token" value="([^"]+)"/.exec(xml)[1];
    expect(tokens.consume(token, sid)).toMatchObject({
      callSid: sid,
      from: "+15551230009",
    });
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
