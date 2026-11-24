jest.mock("../../src/db", () => ({ query: jest.fn() }));
jest.mock("../../src/token", () => ({ callerId: "+15550000001" }));
jest.mock("../../src/assistantSettings", () => ({
  getAssistantSettings: jest.fn(),
}));
jest.mock("../../src/receptionist/store", () => ({
  countAgentCalls: jest.fn(),
}));
jest.mock("../../src/agentProfiles", () => ({
  getProfile: jest.fn(),
  getDefaultProfile: jest.fn(),
}));
const pool = require("../../src/db");
const { getAssistantSettings } = require("../../src/assistantSettings");
const store = require("../../src/receptionist/store");
const { getProfile, getDefaultProfile } = require("../../src/agentProfiles");
const { getConfig } = require("../../src/receptionist/config");
const {
  decideRoute,
  resolveProfile,
} = require("../../src/receptionist/routing");

const IRON_WING = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const JACK_ID = "00000000-0000-4000-8000-0000000000a1";
const DISPATCH_ID = "00000000-0000-4000-8000-0000000000b2";
const jack = {
  id: JACK_ID,
  workspaceId: IRON_WING,
  kind: "receptionist",
  enabled: true,
  isDefault: true,
  dailyLimit: 3,
};
const dispatcher = {
  id: DISPATCH_ID,
  workspaceId: OTHER,
  kind: "dispatcher",
  enabled: true,
  isDefault: false,
  dailyLimit: 20,
};
const otherProvider = {
  workspaceId: OTHER,
  phoneNumber: "+15557770000",
  handler: "ai_agent",
  agentProfileId: DISPATCH_ID,
};
const base = {
  from: "+15551230009",
  to: "+15550000001",
  provider: undefined,
  profile: jack,
};
const onOther = { ...base, to: "+15557770000", provider: otherProvider };
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
  getProfile.mockResolvedValue(null);
  getDefaultProfile.mockResolvedValue(null);
});

describe("decideRoute", () => {
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
      "the legacy number still requires To to be the public number",
      on(),
      { ...base, to: "+15559999999" },
      false,
      "not_public_number",
    ],
    [
      "no profile means no agent",
      on(),
      { ...base, profile: null },
      false,
      "no_agent",
    ],
    [
      "a disabled profile falls back",
      on(),
      { ...base, profile: { ...jack, enabled: false } },
      false,
      "profile_disabled",
    ],
    [
      "a profile that does not belong to the number's workspace falls back",
      on(),
      { ...onOther, profile: jack },
      false,
      "no_agent",
    ],
  ])("%s", async (_name, config, call, agent, reason) => {
    expect(await decideRoute({ ...call, config })).toEqual({ agent, reason });
    expect(pool.query).not.toHaveBeenCalled();
    expect(store.countAgentCalls).not.toHaveBeenCalled();
  });

  test("an ordinary caller reaches the default profile", async () => {
    expect(await decideRoute({ ...base, config: on() })).toEqual({
      agent: true,
      reason: "ok",
    });
    expect(pool.query.mock.calls[0][1]).toEqual([IRON_WING, base.from]);
    expect(getAssistantSettings).toHaveBeenCalledWith(IRON_WING);
  });

  test("a connection number uses its own number and its profile", async () => {
    expect(
      await decideRoute({ ...onOther, profile: dispatcher, config: on() }),
    ).toEqual({ agent: true, reason: "ok" });
  });

  test("jack_enabled gates only the default profile", async () => {
    getAssistantSettings.mockResolvedValue({ jack: false, liveAssist: true });
    expect(await decideRoute({ ...base, config: on() })).toEqual({
      agent: false,
      reason: "workspace_disabled",
    });
    expect(
      await decideRoute({ ...onOther, profile: dispatcher, config: on() }),
    ).toEqual({ agent: true, reason: "ok" });
  });

  test("the workspace switch reads the profile's own workspace", async () => {
    const otherDefault = { ...dispatcher, isDefault: true };
    await decideRoute({ ...onOther, profile: otherDefault, config: on() });
    expect(getAssistantSettings).toHaveBeenCalledWith(OTHER);
  });

  test("the workspace switch turns the default profile off even for a test caller", async () => {
    getAssistantSettings.mockResolvedValue({ jack: false, liveAssist: true });
    const config = on({ testCallers: new Set([base.from]) });
    expect(await decideRoute({ ...base, config })).toEqual({
      agent: false,
      reason: "workspace_disabled",
    });
    expect(store.countAgentCalls).not.toHaveBeenCalled();
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

  test("in test mode, every profile is still limited to test callers", async () => {
    const config = on({ testMode: true });
    expect(await decideRoute({ ...base, config })).toEqual({
      agent: false,
      reason: "test_mode",
    });
    expect(
      await decideRoute({ ...onOther, profile: dispatcher, config }),
    ).toEqual({ agent: false, reason: "test_mode" });
    expect(
      await decideRoute({
        ...onOther,
        profile: dispatcher,
        config: on({ testMode: true, testCallers: new Set([base.from]) }),
      }),
    ).toEqual({ agent: true, reason: "test_caller" });
    expect(pool.query).not.toHaveBeenCalled();
  });

  test("saved contacts skip only receptionists", async () => {
    pool.query.mockResolvedValue({ rows: [{}] });
    expect(await decideRoute({ ...base, config: on() })).toEqual({
      agent: false,
      reason: "contact",
    });
    expect(
      await decideRoute({ ...onOther, profile: dispatcher, config: on() }),
    ).toEqual({ agent: true, reason: "ok" });
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test("the contact lookup uses the profile's workspace", async () => {
    const receptionist = { ...dispatcher, kind: "receptionist" };
    await decideRoute({ ...onOther, profile: receptionist, config: on() });
    expect(pool.query.mock.calls[0][1]).toEqual([OTHER, base.from]);
  });

  test("the daily limit is per profile", async () => {
    store.countAgentCalls.mockResolvedValue(3);
    expect(await decideRoute({ ...base, config: on() })).toEqual({
      agent: false,
      reason: "limit",
    });
    expect(store.countAgentCalls).toHaveBeenCalledWith(base.from, JACK_ID);
    expect(
      await decideRoute({ ...onOther, profile: dispatcher, config: on() }),
    ).toEqual({ agent: true, reason: "ok" });
    expect(store.countAgentCalls).toHaveBeenLastCalledWith(
      base.from,
      DISPATCH_ID,
    );
    store.countAgentCalls.mockResolvedValue(20);
    expect(
      await decideRoute({ ...onOther, profile: dispatcher, config: on() }),
    ).toEqual({ agent: false, reason: "limit" });
  });

  test("a blocked caller ID still reaches the agent", async () => {
    expect(
      await decideRoute({ ...base, from: "anonymous", config: on() }),
    ).toEqual({ agent: true, reason: "ok" });
    expect(pool.query).not.toHaveBeenCalled();
    expect(store.countAgentCalls).toHaveBeenCalledWith("anonymous", JACK_ID);
  });

  test("a missing caller number is treated as blocked, not as an error", async () => {
    expect(
      await decideRoute({ ...base, from: undefined, config: on() }),
    ).toEqual({ agent: true, reason: "ok" });
    expect(store.countAgentCalls).toHaveBeenCalledWith("anonymous", JACK_ID);
  });

  test("a withheld caller ID delivered as a pseudo-number is not looked up as a contact", async () => {
    expect(
      await decideRoute({ ...base, from: "+266696687", config: on() }),
    ).toEqual({ agent: true, reason: "ok" });
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe("resolveProfile", () => {
  test("the legacy route is answered by Iron Wing's default profile", async () => {
    getDefaultProfile.mockResolvedValue(jack);
    expect(await resolveProfile(undefined)).toBe(jack);
    expect(getDefaultProfile).toHaveBeenCalledWith(IRON_WING);
    expect(await resolveProfile({ legacy: true, handler: "legacy" })).toBe(
      jack,
    );
  });

  test("with no Iron Wing default profile the legacy route has no agent", async () => {
    expect(await resolveProfile(undefined)).toBeNull();
  });

  test("an ai_agent number resolves its own profile", async () => {
    getProfile.mockResolvedValue(dispatcher);
    expect(await resolveProfile(otherProvider)).toBe(dispatcher);
    expect(getProfile).toHaveBeenCalledWith(DISPATCH_ID);
    expect(getDefaultProfile).not.toHaveBeenCalled();
  });

  test("a softphone number has no agent", async () => {
    getProfile.mockResolvedValue(dispatcher);
    expect(
      await resolveProfile({ ...otherProvider, handler: "softphone" }),
    ).toBeNull();
    expect(getProfile).not.toHaveBeenCalled();
    expect(getDefaultProfile).not.toHaveBeenCalled();
  });

  test("a profile from another workspace falls back", async () => {
    getProfile.mockResolvedValue({ ...dispatcher, workspaceId: IRON_WING });
    expect(await resolveProfile(otherProvider)).toBeNull();
  });

  test("a missing profile falls back", async () => {
    expect(await resolveProfile(otherProvider)).toBeNull();
    expect(
      await resolveProfile({ ...otherProvider, agentProfileId: null }),
    ).toBeNull();
  });
});
