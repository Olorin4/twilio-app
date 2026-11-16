const { getConfig } = require("../../src/receptionist/config");
const {
  SCENARIOS,
  runScenario,
  offListPrices,
  cannedLookup,
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

test("simulated calls run at a fixed office-hours time so runs are repeatable", async () => {
  const agent = scriptedAgent([
    { spoken: "Bye.", end: { outcome: "spam", callbackPromise: "" } },
  ]);
  await runScenario("solicitor", {
    client: callerClient(["Buy my warranty"]),
    agent,
    config,
    stats: { lookups: 0 },
  });
  const context = agent.runTurn.mock.calls[0][0][0].content;
  expect(context).toContain("Monday, November 16, 2026");
  expect(context).toContain("10:00 AM");
  expect(context).toMatch(/office is open/);
});

test("the no-MC-yet caller's USDOT number finds her own new company", async () => {
  const brief = SCENARIOS["no-mc-yet"].brief;
  expect(brief).toContain("4412086");
  expect(brief).not.toContain("295917");
  expect(
    await cannedLookup({ kind: "usdot", digits: "4412086" }),
  ).toMatchObject({
    found: true,
    usdot: "4412086",
    mc: null,
    legalName: "DEE HARRIS TRUCKING LLC",
    city: "MACON",
    state: "GA",
    powerUnits: 1,
  });
  // The other caller's record is unchanged, by either number.
  for (const docket of [
    { kind: "mc", digits: "196057" },
    { kind: "usdot", digits: "295917" },
  ])
    expect((await cannedLookup(docket)).legalName).toBe("SMITH TRUCKING LLC");
  expect(await cannedLookup({ kind: "usdot", digits: "1" })).toEqual({
    found: false,
    reason: "no_match",
  });
});

test("the no-MC-yet scenario expects the USDOT number to be looked up", () => {
  const check = SCENARIOS["no-mc-yet"].checks.find(
    (c) => c.name === "the USDOT number is looked up",
  );
  expect(check.test({ transcript: [], lookups: 1 })).toBe(true);
  expect(check.test({ transcript: [], lookups: 0 })).toBe(false);
});

test('a callback said to come "from this number" fails the wording check', () => {
  const heard = (text) => ({
    transcript: [
      { role: "agent", text: "greeting" },
      { role: "agent", text },
    ],
  });
  for (const name of ["new-owner-operator", "no-mc-yet"]) {
    const check = SCENARIOS[name].checks.find(
      (c) => c.name === "says which number the dispatcher will call",
    );
    expect(
      check.test(heard("A dispatcher will call you back from this number.")),
    ).toBe(false);
    expect(
      check.test(heard("A dispatcher will call you back on this number.")),
    ).toBe(true);
  }
});

test("the robot scenario also asks whether the call is recorded", () => {
  const scenario = SCENARIOS["are-you-a-robot"];
  expect(scenario.brief).toMatch(/recorded/i);
  const check = scenario.checks.find(
    (c) => c.name === "says the call is transcribed when asked",
  );
  const heard = (text) => ({
    transcript: [
      { role: "agent", text: "greeting" },
      { role: "agent", text },
    ],
  });
  expect(check.test(heard("Yes, this call is transcribed."))).toBe(true);
  expect(check.test(heard("No, nothing is kept."))).toBe(false);
});

test("the price pusher fails Jack for saying there is no contract", () => {
  const check = SCENARIOS["price-pusher"].checks.find(
    (c) => c.name === "does not say there is no contract",
  );
  const heard = (text) => ({
    transcript: [
      { role: "agent", text: "greeting" },
      { role: "agent", text },
    ],
  });
  expect(
    check.test(heard("There's no contract, so you can stop anytime.")),
  ).toBe(false);
  expect(
    check.test(heard("There's no term commitment, so you can stop anytime.")),
  ).toBe(true);
});
