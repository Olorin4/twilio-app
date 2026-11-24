jest.mock("../../src/db", () => ({ query: jest.fn() }));
jest.mock("../../src/messageEvents", () => ({ publish: jest.fn() }));
jest.mock("../../src/receptionist/store", () => ({
  STATUSES: ["new", "called", "dismissed"],
  listCalls: jest.fn(),
  setStatus: jest.fn(),
  countNew: jest.fn(),
}));
jest.mock("../../src/visibility", () => ({ lineScope: jest.fn() }));
const http = require("http");
const express = require("express");
const store = require("../../src/receptionist/store");
const { publish } = require("../../src/messageEvents");
const { lineScope } = require("../../src/visibility");
const leads = require("../../src/receptionist/routes");

const sid = `CA${"1".repeat(32)}`;
const ws = "00000000-0000-4000-8000-000000000001";
const member = { id: "00000000-0000-4000-8000-0000000000a1", role: "member" };
// What lineScope answered; the store applies it to every lead query.
const scope = { all: false, visible: ["+15550000001"] };
let server;
let origin;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.workspace = { id: ws };
    req.user = member;
    next();
  });
  app.use("/leads", leads);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => {
  jest.clearAllMocks();
  lineScope.mockResolvedValue(scope);
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const post = (path, body) =>
  fetch(origin + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("GET /leads maps rows to camelCase", async () => {
  store.listCalls.mockResolvedValue([
    {
      call_sid: sid,
      from_number: "+15551230009",
      started_at: "2026-11-16T15:00:00.000Z",
      ended_at: "2026-11-16T15:04:00.000Z",
      outcome: "lead",
      status: "new",
      caller_name: "Mike Alvarez",
      company: "Alvarez Hauling LLC",
      mc_number: "1234567",
      usdot: "7654321",
      mc_verified: true,
      callback_number: null,
      callback_promise: "in the next few minutes",
      carrier: { city: "DALLAS" },
      details: { unanswered: [] },
      summary: "Two dry vans.",
      script: { opener: "Hi" },
      transcript: [{ role: "caller", text: "hi" }],
    },
  ]);
  const res = await fetch(`${origin}/leads`);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual([
    {
      callSid: sid,
      from: "+15551230009",
      startedAt: "2026-11-16T15:00:00.000Z",
      endedAt: "2026-11-16T15:04:00.000Z",
      outcome: "lead",
      status: "new",
      callerName: "Mike Alvarez",
      company: "Alvarez Hauling LLC",
      mcNumber: "1234567",
      usdot: "7654321",
      mcVerified: true,
      callbackNumber: null,
      callbackPromise: "in the next few minutes",
      carrier: { city: "DALLAS" },
      details: { unanswered: [] },
      summary: "Two dry vans.",
      script: { opener: "Hi" },
      transcript: [{ role: "caller", text: "hi" }],
    },
  ]);
  expect(lineScope).toHaveBeenCalledWith(member, ws);
  expect(store.listCalls).toHaveBeenCalledWith(ws, scope);
});

test("a storage failure on the list is a 500 with a plain message", async () => {
  store.listCalls.mockRejectedValue(new Error("secret detail"));
  const res = await fetch(`${origin}/leads`);
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "Could not load leads." });
});

test("before the migration has run the list is empty, not an error", async () => {
  store.listCalls.mockRejectedValue(
    Object.assign(new Error("missing"), { code: "42P01" }),
  );
  const res = await fetch(`${origin}/leads`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual([]);
});

test("the unread count is a number and survives a missing table", async () => {
  store.countNew.mockResolvedValue(3);
  expect(await (await fetch(`${origin}/leads/count`)).json()).toEqual({
    leads: 3,
  });
  expect(store.countNew).toHaveBeenCalledWith(ws, scope);
  store.countNew.mockRejectedValue(
    Object.assign(new Error("missing"), { code: "42P01" }),
  );
  const res = await fetch(`${origin}/leads/count`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ leads: 0 });
});

test("a status change is saved and announced", async () => {
  store.setStatus.mockResolvedValue(true);
  const res = await post(`/leads/${sid}/status`, { status: "called" });
  expect(res.status).toBe(204);
  expect(store.setStatus).toHaveBeenCalledWith(ws, sid, "called", scope);
  expect(publish).toHaveBeenCalledTimes(1);
});

test("status change validates the SID and the status", async () => {
  expect(
    (await post("/leads/not-a-sid/status", { status: "called" })).status,
  ).toBe(400);
  expect(
    (await post(`/leads/${sid}/status`, { status: "archived" })).status,
  ).toBe(400);
  expect((await post(`/leads/${sid}/status`, {})).status).toBe(400);
  expect(store.setStatus).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
});

test("a scope that can't be read fails closed", async () => {
  lineScope.mockRejectedValue(new Error("db down"));
  expect((await fetch(`${origin}/leads`)).status).toBe(500);
  expect(await (await fetch(`${origin}/leads/count`)).json()).toEqual({
    leads: 0,
  });
  expect(
    (await post(`/leads/${sid}/status`, { status: "called" })).status,
  ).toBe(500);
  expect(store.listCalls).not.toHaveBeenCalled();
  expect(store.setStatus).not.toHaveBeenCalled();
});

// A lead on a line the person may not see is answered as unknown.
test("status change returns 404 for another workspace's call or a hidden lead", async () => {
  store.setStatus.mockResolvedValue(false);
  expect(
    (await post(`/leads/${sid}/status`, { status: "called" })).status,
  ).toBe(404);
  expect(publish).not.toHaveBeenCalled();
});

test("GET /leads names the agent that took the call, null for old calls", async () => {
  store.listCalls.mockResolvedValue([
    { call_sid: sid, agent_kind: "support", agent_persona_name: "Ava" },
    { call_sid: sid, agent_kind: null, agent_persona_name: null },
  ]);
  const [ava, old] = await (await fetch(`${origin}/leads`)).json();
  expect(ava).toMatchObject({ agentKind: "support", agentPersonaName: "Ava" });
  expect(old).toMatchObject({ agentKind: null, agentPersonaName: null });
});
