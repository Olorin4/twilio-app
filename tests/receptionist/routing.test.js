jest.mock("../../src/db", () => ({ query: jest.fn() }));
jest.mock("../../src/token", () => ({ callerId: "+15550000001" }));
jest.mock("../../src/assistantSettings", () => ({
  getAssistantSettings: jest.fn(),
}));
jest.mock("../../src/receptionist/store", () => ({
  countAgentCalls: jest.fn(),
}));
const pool = require("../../src/db");
const { getAssistantSettings } = require("../../src/assistantSettings");
const store = require("../../src/receptionist/store");
const { getConfig } = require("../../src/receptionist/config");
const { decideRoute } = require("../../src/receptionist/routing");

const IRON_WING = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const base = { from: "+15551230009", to: "+15550000001", provider: undefined };
const on = (extra = {}) => ({
  ...getConfig({
    RECEPTIONIST_ENABLED: "true",
    RECEPTIONIST_TEST_MODE: "false",
  }),
  ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [] });
  getAssistantSettings.mockResolvedValue({ jack: true, liveAssist: true });
  store.countAgentCalls.mockResolvedValue(0);
});

test.each([
  ["disabled", getConfig({}), base, false, "disabled"],
  [
    "softphone outgoing call",
    on(),
    { ...base, from: "client:operator" },
    false,
    "outgoing",
  ],
  [
    "call to another number",
    on(),
    { ...base, to: "+15559999999" },
    false,
    "not_public_number",
  ],
  [
    "another workspace's connection",
    on(),
    {
      ...base,
      provider: { workspaceId: OTHER, phoneNumber: "+15550000001" },
    },
    false,
    "not_iron_wing",
  ],
])("%s", async (_name, config, call, agent, reason) => {
  expect(await decideRoute({ ...call, config })).toEqual({ agent, reason });
  expect(pool.query).not.toHaveBeenCalled();
});

test("an ordinary caller reaches the agent", async () => {
  expect(await decideRoute({ ...base, config: on() })).toEqual({
    agent: true,
    reason: "ok",
  });
  expect(pool.query.mock.calls[0][1]).toEqual([IRON_WING, base.from]);
});

test("a saved Iron Wing connection uses its own number", async () => {
  const provider = { workspaceId: IRON_WING, phoneNumber: "+15557770000" };
  expect(
    await decideRoute({
      ...base,
      to: "+15557770000",
      provider,
      config: on(),
    }),
  ).toEqual({ agent: true, reason: "ok" });
});

test("a test caller reaches the agent even when saved as a contact and over the limit", async () => {
  const config = on({ testMode: true, testCallers: new Set([base.from]) });
  expect(await decideRoute({ ...base, config })).toEqual({
    agent: true,
    reason: "test_caller",
  });
  expect(pool.query).not.toHaveBeenCalled();
  expect(store.countAgentCalls).not.toHaveBeenCalled();
});

test("the workspace switch turns Jack off even for a test caller", async () => {
  getAssistantSettings.mockResolvedValue({ jack: false, liveAssist: true });
  const config = on({ testCallers: new Set([base.from]) });
  expect(await decideRoute({ ...base, config })).toEqual({
    agent: false,
    reason: "workspace_disabled",
  });
  expect(store.countAgentCalls).not.toHaveBeenCalled();
});

test("in test mode everyone else stays on today's behaviour", async () => {
  expect(
    await decideRoute({ ...base, config: on({ testMode: true }) }),
  ).toEqual({ agent: false, reason: "test_mode" });
  expect(pool.query).not.toHaveBeenCalled();
});

test("saved contacts skip the agent", async () => {
  pool.query.mockResolvedValueOnce({ rows: [{}] });
  expect(await decideRoute({ ...base, config: on() })).toEqual({
    agent: false,
    reason: "contact",
  });
});

test("the fourth agent call in a day falls back", async () => {
  store.countAgentCalls.mockResolvedValue(3);
  expect(await decideRoute({ ...base, config: on() })).toEqual({
    agent: false,
    reason: "limit",
  });
  expect(store.countAgentCalls).toHaveBeenCalledWith(base.from);
});

test("a blocked caller ID still reaches the agent", async () => {
  expect(
    await decideRoute({ ...base, from: "anonymous", config: on() }),
  ).toEqual({ agent: true, reason: "ok" });
  expect(pool.query).not.toHaveBeenCalled();
  expect(store.countAgentCalls).toHaveBeenCalledWith("anonymous");
});

test("a missing caller number is treated as blocked, not as an error", async () => {
  expect(await decideRoute({ ...base, from: undefined, config: on() })).toEqual(
    { agent: true, reason: "ok" },
  );
  expect(store.countAgentCalls).toHaveBeenCalledWith("anonymous");
});

test("a withheld caller ID delivered as a pseudo-number is not looked up as a contact", async () => {
  expect(
    await decideRoute({ ...base, from: "+266696687", config: on() }),
  ).toEqual({ agent: true, reason: "ok" });
  expect(pool.query).not.toHaveBeenCalled();
});
