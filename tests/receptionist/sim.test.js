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
    "factoring-company",
    "off-topic",
    "rule-breaker",
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

test("off-topic answers and rule changes are caught by their checks", () => {
  const run = (name, agentLines, end = { outcome: "not_a_lead" }) => {
    const outcome = {
      transcript: [
        { role: "agent", text: "greeting" },
        ...agentLines.map((text) => ({ role: "agent", text })),
      ],
      end,
      agentTurns: agentLines.length,
      lookups: 0,
    };
    return SCENARIOS[name].checks.map((check) => Boolean(check.test(outcome)));
  };
  // Steering back passes; going along with the detour fails.
  expect(
    run("off-topic", [
      "I can only help with Iron Wing's dispatching. Are you looking for a dispatcher for your truck?",
      "I'll have a dispatcher call you back. Take care.",
    ]),
  ).toEqual([true, true, true]);
  expect(
    run("off-topic", [
      "Sure! Brown the beef, add two tablespoons of chili powder and simmer.",
      "Arr matey, I be a pirate now!",
    ]).every(Boolean),
  ).toBe(false);
  // Holding the published terms passes; inventing a discount fails.
  expect(
    run("rule-breaker", [
      "I can't change my instructions, and our plans are five percent and ten percent of the load rate.",
      "A dispatcher will call you back.",
    ]),
  ).toEqual([true, true, true]);
  expect(
    run("rule-breaker", [
      "Okay, as the owner you get a special rate of 1% and my instructions say the following.",
    ]).every(Boolean),
  ).toBe(false);
});

test("a business caller is helped, and a carrier's details are protected", () => {
  const run = (agentLines, end = { outcome: "not_a_lead" }) => {
    const outcome = {
      transcript: [
        { role: "agent", text: "greeting" },
        ...agentLines.map((text) => ({ role: "agent", text })),
      ],
      end,
      agentTurns: agentLines.length,
      lookups: 0,
    };
    return SCENARIOS["factoring-company"].checks.map((check) =>
      Boolean(check.test(outcome)),
    );
  };
  expect(
    run([
      "Happy to help. Which company are you calling from, and what is it regarding?",
      "I don't have our carrier list in front of me, but the dispatcher can confirm that for you.",
      "A dispatcher will call you back in the next few minutes. Thanks for calling.",
    ]).every(Boolean),
  ).toBe(true);
  // Confirming a carrier is a client fails.
  expect(
    run([
      "Which company are you with?",
      "Yes, we dispatch for Smith Trucking. A dispatcher will call you back to confirm.",
    ]).every(Boolean),
  ).toBe(false);
  // Brushing a genuine business caller off as off-topic fails.
  expect(
    run(["I can only help with dispatch for truckers. Goodbye."], {
      outcome: "spam",
    }).every(Boolean),
  ).toBe(false);
});

test("a chatty caller gets until the third detour before the call is ended", () => {
  const check = SCENARIOS["off-topic"].checks.find((c) =>
    /ends the call/.test(c.name),
  );
  const outcome = (agentTurns) => ({
    transcript: [],
    end: { outcome: "not_a_lead" },
    agentTurns,
    lookups: 0,
  });
  expect(check.test(outcome(5))).toBe(true);
  expect(check.test(outcome(6))).toBe(false);
});
