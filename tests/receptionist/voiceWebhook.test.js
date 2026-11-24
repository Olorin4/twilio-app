/* Drives the real Express router over HTTP to prove the voice webhooks hand
calls to the receptionist, and fall back to today's TwiML otherwise. */
jest.mock("../../src/token", () => ({
  accountSid: "ACtest",
  authToken: "test",
  appSid: "APtest",
  apiKey: "SKtest",
  apiSecret: "secret",
  callerId: "+15550000001",
  client: {},
  tokenGenerator: jest.fn(),
  tokenFor: jest.fn(),
  getIdentity: () => "operator",
}));
jest.mock("../../src/db", () => ({ query: jest.fn() }));
jest.mock("../../src/logManager", () => ({
  logCall: jest.fn(),
  logMessage: jest.fn(),
  getCallLogs: jest.fn(),
  getMessageLogs: jest.fn(),
}));
jest.mock("../../src/security", () => ({
  ...jest.requireActual("../../src/security"),
  validateWebhook: (req, res, next) => next(),
}));
jest.mock("../../src/connectionWebhooks", () => ({
  authenticateConnectionWebhook: (req, res, next) => {
    req.providerConnection = {
      id: req.params.connectionId,
      workspaceId: "00000000-0000-4000-8000-000000000001",
    };
    next();
  },
}));
jest.mock("../../src/providerContext", () => ({
  getProvider: jest.fn(),
  getProviderForWebhook: jest.fn(),
  legacyProvider: jest.fn(),
}));
jest.mock("../../src/receptionist/twiml", () => ({
  agentTwiml: jest.fn(),
  endedHandler: jest.fn((req, res) => res.type("text/xml").send("<ended/>")),
}));

const http = require("http");
const express = require("express");
const bodyParser = require("body-parser");
const { getProviderForWebhook } = require("../../src/providerContext");
const { agentTwiml, endedHandler } = require("../../src/receptionist/twiml");
const { logCall } = require("../../src/logManager");

const sid = `CA${"1".repeat(32)}`;
const id = "00000000-0000-4000-8000-000000000002";
const relay = "<Response><Connect><ConversationRelay/></Connect></Response>";
const form = { CallSid: sid, From: "+15551230009", To: "+15550000001" };
let server;
let origin;

beforeAll(async () => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  const app = express();
  app.use(bodyParser.urlencoded({ extended: false }));
  // index.js signs non-webhook requests in; stand in for a signed-in owner.
  app.use((req, res, next) => {
    req.user = { id: null, role: "owner", bootstrap: true, workspaceIds: [] };
    next();
  });
  app.use(require("../../src/router"));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  jest.restoreAllMocks();
});
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({
    doNotFake: [
      "nextTick",
      "setImmediate",
      "setTimeout",
      "setInterval",
      "clearTimeout",
      "clearInterval",
    ],
  });
  jest.setSystemTime(new Date("2026-11-16T15:00:00Z"));
});
afterEach(() => jest.useRealTimers());

const post = (path, fields = form) =>
  fetch(origin + path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

test("the legacy voice webhook hands an agent call to ConversationRelay", async () => {
  agentTwiml.mockResolvedValue(relay);
  const res = await post("/voice");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/text\/xml/);
  expect(await res.text()).toBe(relay);
  expect(agentTwiml).toHaveBeenCalledWith({
    body: expect.objectContaining(form),
    provider: undefined,
    connection: undefined,
  });
  expect(logCall).toHaveBeenCalledTimes(1);
});

test("a call the agent does not take gets exactly today's TwiML", async () => {
  agentTwiml.mockResolvedValue(null);
  const { voiceResponse } = require("../../src/callResponse");
  const res = await post("/voice");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe(voiceResponse(form));
});

test("the connection voice webhook passes its provider and connection", async () => {
  const provider = {
    id,
    workspaceId: "00000000-0000-4000-8000-000000000001",
    phoneNumber: form.To,
    voiceEnabled: true,
  };
  getProviderForWebhook.mockResolvedValue(provider);
  agentTwiml.mockResolvedValue(relay);
  const res = await post(`/webhooks/${id}/voice`);
  expect(await res.text()).toBe(relay);
  expect(agentTwiml).toHaveBeenCalledWith({
    body: expect.objectContaining(form),
    provider,
    connection: expect.objectContaining({ id }),
  });
});

test("outgoing softphone calls never consult the receptionist", async () => {
  const { getProvider } = require("../../src/providerContext");
  getProvider.mockResolvedValue({ legacy: true });
  const res = await post("/voice", {
    CallSid: sid,
    From: "client:operator",
    To: "+15557654321",
  });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("<Number>+15557654321</Number>");
  expect(agentTwiml).not.toHaveBeenCalled();
});

test("both session-ended routes reach the handler", async () => {
  expect(await (await post("/receptionist/ended")).text()).toBe("<ended/>");
  expect(await (await post(`/webhooks/${id}/receptionist/ended`)).text()).toBe(
    "<ended/>",
  );
  expect(endedHandler).toHaveBeenCalledTimes(2);
});

test("the leads API is mounted on the router with a workspace", async () => {
  const pool = require("../../src/db");
  pool.query.mockImplementation(async (sql) =>
    /FROM workspaces/.test(sql)
      ? {
          rows: [
            { id: "00000000-0000-4000-8000-000000000001", name: "Iron Wing" },
          ],
        }
      : { rows: [{ count: "2" }] },
  );
  const res = await fetch(`${origin}/leads/count`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ leads: 2 });
});

const person = "00000000-0000-4000-8000-0000000000e1";
const compact = (value) => value.replace(/-/g, "");
const ringQuery = (pool) =>
  pool.query.mock.calls.filter(([sql]) => /number_assignees/.test(sql));

test("an inbound call the agent does not take rings the line's people", async () => {
  const pool = require("../../src/db");
  pool.query.mockReset();
  pool.query.mockResolvedValueOnce({ rows: [{ id: person }] });
  getProviderForWebhook.mockResolvedValue({
    id,
    numberId: "00000000-0000-4000-8000-0000000000e2",
    workspaceId: "00000000-0000-4000-8000-000000000001",
    phoneNumber: form.To,
    voiceEnabled: true,
  });
  agentTwiml.mockResolvedValue(null);
  const text = await (await post(`/webhooks/${id}/voice`)).text();
  expect(text).toContain(
    `<Identity>u${compact(person)}_c${compact(id)}</Identity>`,
  );
  expect(text).not.toContain("connection_");
  expect(ringQuery(pool)).toHaveLength(1);
});

test("the legacy voice webhook rings the owners", async () => {
  const pool = require("../../src/db");
  pool.query.mockReset();
  pool.query.mockResolvedValueOnce({ rows: [{ id: person }] });
  agentTwiml.mockResolvedValue(null);
  const text = await (await post("/voice")).text();
  expect(text).toContain(`>u${compact(person)}_legacy</Client>`);
  expect(text).not.toContain(">operator</Client>");
});

test("an agent call does not wait for the ring list", async () => {
  const pool = require("../../src/db");
  pool.query.mockReset();
  getProviderForWebhook.mockResolvedValue({
    id,
    workspaceId: "00000000-0000-4000-8000-000000000001",
    phoneNumber: form.To,
    voiceEnabled: true,
  });
  agentTwiml.mockResolvedValue(relay);
  expect(await (await post(`/webhooks/${id}/voice`)).text()).toBe(relay);
  expect(await (await post("/voice")).text()).toBe(relay);
  expect(ringQuery(pool)).toHaveLength(0);
});

test("outgoing softphone calls never read the ring list", async () => {
  const pool = require("../../src/db");
  pool.query.mockReset();
  const { getProvider } = require("../../src/providerContext");
  getProvider.mockResolvedValue({ legacy: true });
  await post("/voice", {
    CallSid: sid,
    From: "client:operator",
    To: "+15557654321",
  });
  expect(ringQuery(pool)).toHaveLength(0);
});
