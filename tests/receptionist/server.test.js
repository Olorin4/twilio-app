jest.mock("../../src/connectionWebhooks", () => ({
  loadConnectionAuth: jest.fn(),
}));
const http = require("http");
const twilio = require("twilio");
const WebSocket = require("ws");
const { loadConnectionAuth } = require("../../src/connectionWebhooks");
const { attach, validateSignature } = require("../../src/receptionist/server");
const {
  createSession: realSession,
} = require("../../src/receptionist/session");
const { fixedLines } = require("../../src/receptionist/prompt");
const { JACK } = require("../../src/receptionist/seed/jack");

const sid = `CA${"1".repeat(32)}`;
const id = "00000000-0000-4000-8000-000000000002";
const context = {
  callSid: sid,
  workspaceId: "00000000-0000-4000-8000-000000000001",
  connectionId: null,
  from: "+15551230009",
  agentProfileId: "00000000-0000-4000-8000-0000000000a1",
};
const profile = {
  ...JACK,
  id: context.agentProfileId,
  workspaceId: context.workspaceId,
};
const setup = {
  type: "setup",
  callSid: sid,
  customParameters: { token: "good" },
};

let server;
let port;
let deps;
let sessions;

function makeDeps(overrides = {}) {
  sessions = [];
  return {
    validateSignature: jest.fn().mockResolvedValue(true),
    tokens: {
      consume: jest.fn((token, callSid) =>
        token === "good" && callSid === sid ? context : null,
      ),
    },
    getProfile: jest.fn().mockResolvedValue(profile),
    createClient: jest.fn(() => ({ fake: "client" })),
    createAgent: jest.fn(() => ({ fake: "agent" })),
    createSession: jest.fn((options) => {
      const session = {
        options,
        handle: jest.fn(),
        closed: jest.fn(),
      };
      sessions.push(session);
      return session;
    }),
    finalize: jest.fn().mockResolvedValue(),
    setupTimeoutMs: 80,
    ...overrides,
  };
}

async function listen(overrides) {
  deps = makeDeps(overrides);
  server = http.createServer((req, res) => res.end("ok"));
  attach(server, deps);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
}

const clients = [];
const connect = (path = "/receptionist/ws") => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  clients.push(ws);
  return ws;
};
const opened = (ws) => new Promise((resolve) => ws.once("open", resolve));
const closedWith = (ws) =>
  new Promise((resolve) => ws.once("close", (code) => resolve(code)));
const until = async (check) => {
  for (let i = 0; i < 200 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
};

beforeEach(() => jest.spyOn(console, "error").mockImplementation(() => {}));
afterEach(async () => {
  jest.restoreAllMocks();
  // A failed assertion must not leave a socket open and hang the suite.
  for (const ws of clients.splice(0)) ws.terminate();
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
  delete process.env.TWILIO_WEBHOOK_BASE_URL;
  delete process.env.TWILIO_AUTH_TOKEN;
});

test("an unknown upgrade path is refused", async () => {
  await listen();
  const ws = connect("/something-else");
  await new Promise((resolve) => ws.once("error", resolve));
  expect(deps.validateSignature).not.toHaveBeenCalled();
  expect(deps.createSession).not.toHaveBeenCalled();
});

test("a bad signature is refused with 403", async () => {
  await listen({ validateSignature: jest.fn().mockResolvedValue(false) });
  const ws = connect();
  const status = await new Promise((resolve) => {
    ws.once("unexpected-response", (req, res) => resolve(res.statusCode));
    ws.once("error", () => {});
  });
  expect(status).toBe(403);
  expect(deps.createSession).not.toHaveBeenCalled();
});

test("a signature check that throws is treated as a refusal", async () => {
  await listen({
    validateSignature: jest.fn().mockRejectedValue(new Error("db down")),
  });
  const ws = connect();
  const status = await new Promise((resolve) => {
    ws.once("unexpected-response", (req, res) => resolve(res.statusCode));
    ws.once("error", () => {});
  });
  expect(status).toBe(403);
});

test("a connection that never sends setup is closed", async () => {
  await listen();
  const ws = connect();
  expect(await closedWith(ws)).toBe(1008);
  expect(deps.createSession).not.toHaveBeenCalled();
});

test("setup with an unknown token is closed with 1008", async () => {
  await listen();
  const ws = connect();
  await opened(ws);
  ws.send(JSON.stringify({ ...setup, customParameters: { token: "bad" } }));
  expect(await closedWith(ws)).toBe(1008);
  expect(deps.tokens.consume).toHaveBeenCalledWith("bad", sid);
  expect(deps.createSession).not.toHaveBeenCalled();
});

test("a first message that is not setup is refused", async () => {
  await listen();
  const ws = connect();
  await opened(ws);
  ws.send(JSON.stringify({ type: "prompt", voicePrompt: "hi", last: true }));
  expect(await closedWith(ws)).toBe(1008);
});

test("setup with a valid token starts a session and forwards messages both ways", async () => {
  await listen();
  const ws = connect();
  await opened(ws);
  ws.send(JSON.stringify(setup));
  await until(() => sessions.length === 1);
  const session = sessions[0];
  expect(session.options.context).toEqual(context);
  expect(session.options.agent).toEqual({ fake: "agent" });
  expect(deps.getProfile).toHaveBeenCalledWith(context.agentProfileId);
  expect(deps.createAgent).toHaveBeenCalledWith(
    expect.objectContaining({ client: { fake: "client" }, profile }),
  );
  expect(session.options.profile).toBe(profile);
  expect(session.handle).toHaveBeenCalledWith(setup);

  ws.send("not json");
  const prompt = { type: "prompt", voicePrompt: "hello", last: true };
  ws.send(JSON.stringify(prompt));
  await until(() => session.handle.mock.calls.length === 2);
  expect(session.handle).toHaveBeenLastCalledWith(prompt);

  const received = new Promise((resolve) =>
    ws.once("message", (data) => resolve(JSON.parse(data.toString()))),
  );
  session.options.send({ type: "text", token: "Hi.", last: true });
  expect(await received).toEqual({ type: "text", token: "Hi.", last: true });
  ws.close();
});

test("socket close reaches session.closed", async () => {
  await listen();
  const ws = connect();
  await opened(ws);
  ws.send(JSON.stringify(setup));
  await until(() => sessions.length === 1);
  ws.close();
  await until(() => sessions[0].closed.mock.calls.length === 1);
  expect(sessions[0].closed).toHaveBeenCalledTimes(1);
});

test("the finished call is handed to finalize with its context and the client", async () => {
  await listen();
  const ws = connect();
  await opened(ws);
  ws.send(JSON.stringify(setup));
  await until(() => sessions.length === 1);
  const result = { callSid: sid, outcome: "lead", transcript: [] };
  sessions[0].options.onFinished(result);
  await until(() => deps.finalize.mock.calls.length === 1);
  expect(deps.finalize).toHaveBeenCalledWith(
    result,
    context,
    expect.objectContaining({ client: { fake: "client" } }),
  );
  ws.close();
});

test("a failing finalize is logged, not thrown", async () => {
  await listen({ finalize: jest.fn().mockRejectedValue(new Error("boom")) });
  const ws = connect();
  await opened(ws);
  ws.send(JSON.stringify(setup));
  await until(() => sessions.length === 1);
  expect(() => sessions[0].options.onFinished({ callSid: sid })).not.toThrow();
  await until(() => console.error.mock.calls.length > 0);
  ws.close();
});

test("an error while handling a message is logged and the socket keeps working", async () => {
  await listen();
  const ws = connect();
  await opened(ws);
  ws.send(JSON.stringify(setup));
  await until(() => sessions.length === 1);
  const session = sessions[0];
  session.handle.mockImplementationOnce(() => {
    throw new Error("bad state");
  });
  ws.send(JSON.stringify({ type: "prompt", voicePrompt: "one", last: true }));
  await until(() => session.handle.mock.calls.length === 2);
  ws.send(JSON.stringify({ type: "prompt", voicePrompt: "two", last: true }));
  await until(() => session.handle.mock.calls.length === 3);
  expect(console.error).toHaveBeenCalled();
  expect(ws.readyState).toBe(WebSocket.OPEN);
  ws.close();
});

test("an error while starting the session refuses the socket instead of crashing", async () => {
  await listen({
    createSession: jest.fn(() => {
      throw new Error("bad config");
    }),
  });
  const ws = connect();
  await opened(ws);
  ws.send(JSON.stringify(setup));
  expect(await closedWith(ws)).toBe(1011);
});

test("a missing API key does not crash: the session gets a failing agent", async () => {
  await listen({
    createClient: jest.fn(() => {
      throw new Error("no credentials");
    }),
  });
  const ws = connect();
  await opened(ws);
  ws.send(JSON.stringify(setup));
  await until(() => sessions.length === 1);
  const { agent } = sessions[0].options;
  expect(deps.createAgent).not.toHaveBeenCalled();
  await expect(agent.prewarm()).resolves.toBeUndefined();
  const history = [{ role: "user", content: "hi" }];
  expect(await agent.runTurn(history, {})).toEqual({
    history,
    spoken: "",
    end: null,
    carrier: null,
    failed: true,
  });
  ws.close();
});

describe("the call's agent profile", () => {
  // Runs a real session: setup, then one caller turn, and returns the first
  // text the caller is sent.
  async function firstLine(overrides) {
    await listen({ createSession: realSession, ...overrides });
    const ws = connect();
    await opened(ws);
    const received = new Promise((resolve) =>
      ws.once("message", (data) => resolve(JSON.parse(data.toString()))),
    );
    ws.send(JSON.stringify(setup));
    ws.send(JSON.stringify({ type: "prompt", voicePrompt: "hi", last: true }));
    const message = await received;
    ws.close();
    return message;
  }

  // Runs a real session whose profile cannot be used, and returns the close
  // code and every message the caller was sent. A 1011 close makes Twilio's
  // <Connect action> call endedHandler, which rings the softphone.
  async function refusedWith(getProfile) {
    await listen({ createSession: jest.fn(realSession), getProfile });
    const ws = connect();
    await opened(ws);
    const messages = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    const closed = closedWith(ws);
    ws.send(JSON.stringify(setup));
    ws.send(JSON.stringify({ type: "prompt", voicePrompt: "hi", last: true }));
    return { code: await closed, messages };
  }

  test.each([
    ["missing", () => jest.fn().mockResolvedValue(null)],
    ["unreadable", () => jest.fn().mockRejectedValue(new Error("db down"))],
    [
      "in another workspace",
      () =>
        jest.fn().mockResolvedValue({
          ...profile,
          workspaceId: "00000000-0000-4000-8000-0000000000ff",
        }),
    ],
  ])(
    "a profile that is %s closes with 1011 and plays no fallback line",
    async (_, makeGetProfile) => {
      const { code, messages } = await refusedWith(makeGetProfile());
      expect(code).toBe(1011);
      expect(messages).toEqual([]);
      expect(deps.createSession).not.toHaveBeenCalled();
      expect(deps.createAgent).not.toHaveBeenCalled();
      expect(deps.finalize).not.toHaveBeenCalled();
    },
  );

  test("a known profile whose agent cannot start speaks its own fallback", async () => {
    const message = await firstLine({
      createClient: jest.fn(() => {
        throw new Error("no credentials");
      }),
    });
    expect(message.token).toBe(fixedLines(profile).fallback);
  });

  test("messages that arrive while the profile loads are kept in order", async () => {
    let resolve;
    await listen({
      getProfile: jest.fn(
        () => new Promise((done) => (resolve = () => done(profile))),
      ),
    });
    const ws = connect();
    await opened(ws);
    const prompt = { type: "prompt", voicePrompt: "hello", last: true };
    ws.send(JSON.stringify(setup));
    ws.send(JSON.stringify(prompt));
    await until(() => deps.getProfile.mock.calls.length === 1);
    await new Promise((done) => setTimeout(done, 20));
    expect(deps.tokens.consume).toHaveBeenCalledTimes(1);
    resolve();
    await until(() => sessions[0]?.handle.mock.calls.length === 2);
    expect(sessions[0].handle.mock.calls.map(([m]) => m)).toEqual([
      setup,
      prompt,
    ]);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});

test("a socket that closes while the profile loads still finishes the call", async () => {
  let resolve;
  await listen({
    getProfile: jest.fn(
      () => new Promise((done) => (resolve = () => done(profile))),
    ),
  });
  const ws = connect();
  await opened(ws);
  ws.send(JSON.stringify(setup));
  await until(() => deps.getProfile.mock.calls.length === 1);
  ws.close();
  await closedWith(ws);
  resolve();
  await until(() => sessions[0]?.closed.mock.calls.length === 1);
  expect(sessions[0].closed).toHaveBeenCalledTimes(1);
});

describe("validateSignature", () => {
  const request = (url, signature) => ({
    url,
    headers: signature ? { "x-twilio-signature": signature } : {},
  });
  beforeEach(() => {
    process.env.TWILIO_WEBHOOK_BASE_URL = "https://example.test/";
    process.env.TWILIO_AUTH_TOKEN = "legacy-token";
  });

  test("accepts Twilio's signature over the wss or https form of the URL", async () => {
    for (const url of [
      "wss://example.test/receptionist/ws",
      "https://example.test/receptionist/ws",
    ]) {
      const signature = twilio.getExpectedTwilioSignature(
        "legacy-token",
        url,
        {},
      );
      expect(
        await validateSignature(request("/receptionist/ws", signature)),
      ).toBe(true);
    }
  });

  test("rejects a missing or wrong signature", async () => {
    expect(await validateSignature(request("/receptionist/ws"))).toBe(false);
    const forged = twilio.getExpectedTwilioSignature(
      "another-token",
      "wss://example.test/receptionist/ws",
      {},
    );
    expect(await validateSignature(request("/receptionist/ws", forged))).toBe(
      false,
    );
  });

  test("a connection path is checked with that connection's token", async () => {
    loadConnectionAuth.mockResolvedValue({ id, authToken: "conn-token" });
    const path = `/webhooks/${id}/receptionist/ws`;
    const signature = twilio.getExpectedTwilioSignature(
      "conn-token",
      `wss://example.test${path}`,
      {},
    );
    expect(await validateSignature(request(path, signature), id)).toBe(true);
    expect(loadConnectionAuth).toHaveBeenCalledWith(id);
    loadConnectionAuth.mockResolvedValue(null);
    expect(await validateSignature(request(path, signature), id)).toBe(false);
  });

  test("without a public base URL nothing is accepted", async () => {
    delete process.env.TWILIO_WEBHOOK_BASE_URL;
    expect(await validateSignature(request("/receptionist/ws", "x"))).toBe(
      false,
    );
  });
});
