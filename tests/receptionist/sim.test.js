const { getConfig } = require("../../src/receptionist/config");
const {
  SCENARIOS,
  runScenario,
  offListPrices,
  main,
} = require("../../scripts/receptionist-sim");

const config = getConfig({});

// A caller model that reads its lines from a script, then hangs up.
const callerClient = (lines) => {
  let turn = 0;
  return {
    messages: {
      create: jest.fn(async () => ({
        content: [{ type: "text", text: lines[turn++] || "[hangs up]" }],
        stop_reason: "end_turn",
      })),
    },
  };
};
// An agent that answers from a script; the last entry may end the call.
const scriptedAgent = (replies) => {
  let turn = 0;
  return {
    runTurn: jest.fn(async (history, { onText }) => {
      const reply = replies[turn++] || { spoken: "Anything else?" };
      onText(reply.spoken);
      if (reply.lookup) reply.lookup();
      return {
        history: [...history, { role: "assistant", content: reply.spoken }],
        spoken: reply.spoken,
        end: reply.end || null,
        carrier: null,
        failed: Boolean(reply.failed),
      };
    }),
  };
};

beforeEach(() => jest.spyOn(console, "log").mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

test("every agreed scenario exists with at least one check", () => {
  expect(Object.keys(SCENARIOS)).toEqual([
    "new-owner-operator",
    "no-mc-yet",
    "existing-customer",
    "broker",
    "price-pusher",
    "are-you-a-robot",
    "wants-a-human",
    "solicitor",
  ]);
  for (const scenario of Object.values(SCENARIOS)) {
    expect(scenario.brief.length).toBeGreaterThan(40);
    expect(scenario.checks.length).toBeGreaterThan(0);
  }
});

test("a scenario runs caller and agent in turn until the agent ends the call", async () => {
  const stats = { lookups: 0 };
  const agent = scriptedAgent([
    { spoken: "Happy to help. What's your MC number?" },
    {
      spoken:
        "One second while I pull that up. I have Smith Trucking. Is that you?",
      lookup: () => stats.lookups++,
    },
    {
      spoken:
        "A dispatcher will call you back in the next few minutes. Drive safe.",
      end: { outcome: "lead", callbackPromise: "in the next few minutes" },
    },
  ]);
  const result = await runScenario("new-owner-operator", {
    client: callerClient([
      "I need dispatch for my dry van",
      "MC 196057",
      "Yes",
    ]),
    agent,
    config,
    stats,
  });
  expect(result.end).toEqual({
    outcome: "lead",
    callbackPromise: "in the next few minutes",
  });
  expect(result.transcript.map((turn) => turn.role)).toEqual([
    "agent",
    "caller",
    "agent",
    "caller",
    "agent",
    "caller",
    "agent",
  ]);
  expect(result.checks.map((check) => check.pass)).toEqual([
    true,
    true,
    true,
    true,
  ]);
  expect(result.pass).toBe(true);
});

test("a scenario whose checks are not met fails", async () => {
  const agent = scriptedAgent([
    { spoken: "Sure, bye.", end: { outcome: "spam", callbackPromise: "" } },
  ]);
  const result = await runScenario("new-owner-operator", {
    client: callerClient(["I need dispatch"]),
    agent,
    config,
    stats: { lookups: 0 },
  });
  expect(result.pass).toBe(false);
  expect(result.checks.some((check) => !check.pass)).toBe(true);
});

test("a call stops after twelve caller turns or when the caller hangs up", async () => {
  const agent = scriptedAgent([]);
  const chatty = await runScenario("price-pusher", {
    client: callerClient(Array(40).fill("And how much is that?")),
    agent,
    config,
    stats: { lookups: 0 },
  });
  expect(agent.runTurn).toHaveBeenCalledTimes(12);
  expect(chatty.end).toBeNull();
  const quiet = scriptedAgent([]);
  await runScenario("price-pusher", {
    client: callerClient(["How much?"]),
    agent: quiet,
    config,
    stats: { lookups: 0 },
  });
  expect(quiet.runTurn).toHaveBeenCalledTimes(1);
});

test("prices that are not the published ones are caught", () => {
  expect(
    offListPrices("It's five percent on Essential and 10% on Full-Service."),
  ).toEqual([]);
  expect(offListPrices("We can do 7% for you, or $300 a week.")).toEqual([
    "7%",
    "$300",
  ]);
  expect(offListPrices("How about three percent?")).toEqual(["three percent"]);
});

test("without --yes it explains the cost and makes no request", async () => {
  const createClient = jest.fn();
  const code = await main([], { createClient });
  expect(code).toBe(1);
  expect(createClient).not.toHaveBeenCalled();
  const printed = console.log.mock.calls.flat().join("\n");
  expect(printed).toContain("claude-opus-5-5");
  expect(printed).toContain("--yes");
});

test("an unknown scenario name is refused before anything runs", async () => {
  const createClient = jest.fn();
  expect(await main(["--yes", "nope"], { createClient })).toBe(1);
  expect(createClient).not.toHaveBeenCalled();
});
