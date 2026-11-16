jest.mock("../../src/db", () => ({ query: jest.fn() }));
jest.mock("../../src/messageEvents", () => ({ publish: jest.fn() }));
jest.mock("../../src/receptionist/store", () => ({
  finishCall: jest.fn(),
  updateSummary: jest.fn(),
  saveCosts: jest.fn(),
}));
const store = require("../../src/receptionist/store");
const { publish } = require("../../src/messageEvents");
const { getConfig } = require("../../src/receptionist/config");
const { finalize } = require("../../src/receptionist/finalize");

const sid = `CA${"1".repeat(32)}`;
const ctx = {
  callSid: sid,
  workspaceId: "00000000-0000-4000-8000-000000000001",
  connectionId: null,
  from: "+15551230009",
};
const transcript = [
  { role: "agent", text: "Thanks for calling." },
  { role: "caller", text: "I need a dispatcher for my dry van" },
];
const result = {
  callSid: sid,
  outcome: "lead",
  callbackPromise: "in the next few minutes",
  carrier: null,
  transcript,
  callerSpoke: true,
};
const summary = (overrides = {}) => ({
  outcome: "lead",
  caller_name: "Mike Alvarez",
  company: "Alvarez Hauling LLC",
  mc_number: null,
  usdot: null,
  callback_number: null,
  fleet_size: "2 trucks",
  equipment: "dry van",
  situation: "Unhappy with current dispatcher.",
  questions: ["What is the fee?"],
  unanswered: ["Factoring paperwork"],
  interest: "high",
  callback_promise: null,
  carrier_confirmed: true,
  summary: "Owner-operator with two dry vans.",
  script: {
    opener: "Mike, this is Iron Wing.",
    points: ["5% Essential plan"],
    objections: [{ objection: "fee", answer: "5% of linehaul" }],
    next_step: "Sign up today",
  },
  ...overrides,
});
const client = { fake: "client" };
let deps;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  const asRow = (callSid, fields) => ({
    call_sid: callSid,
    from_number: ctx.from,
    outcome: fields.outcome,
    caller_name: fields.callerName ?? null,
    company: fields.company ?? null,
    mc_number: fields.mcNumber ?? null,
    mc_verified: Boolean(fields.mcVerified),
    callback_promise: fields.callbackPromise ?? null,
    summary: fields.summary ?? null,
    transcript: fields.transcript ?? transcript,
  });
  store.finishCall.mockImplementation(async (callSid, fields) =>
    asRow(callSid, fields),
  );
  store.updateSummary.mockImplementation(async (callSid, fields) =>
    asRow(callSid, fields),
  );
  deps = {
    client,
    config: getConfig({}),
    summarize: jest.fn().mockResolvedValue(summary()),
    sendLeadEmail: jest.fn().mockResolvedValue(true),
  };
});
afterEach(() => jest.restoreAllMocks());

test("an abandoned call is stored without a model request or email", async () => {
  await finalize(
    { callSid: sid, outcome: "abandoned", callerSpoke: false, transcript: [] },
    ctx,
    deps,
  );
  expect(deps.summarize).not.toHaveBeenCalled();
  expect(deps.sendLeadEmail).not.toHaveBeenCalled();
  expect(store.finishCall).toHaveBeenCalledWith(sid, {
    outcome: "abandoned",
    transcript: [],
  });
  expect(store.updateSummary).not.toHaveBeenCalled();
  expect(publish).toHaveBeenCalledTimes(1);
});

test("the call is saved before the summary is requested", async () => {
  const order = [];
  store.finishCall.mockImplementation(async (callSid, fields) => {
    order.push("save");
    return { call_sid: callSid, outcome: fields.outcome };
  });
  deps.summarize.mockImplementation(async () => {
    order.push("summarize");
    return summary();
  });
  await finalize(result, ctx, deps);
  expect(order).toEqual(["save", "summarize"]);
  expect(store.finishCall).toHaveBeenCalledWith(sid, {
    outcome: "lead",
    company: null,
    mcNumber: null,
    usdot: null,
    mcVerified: false,
    callbackPromise: "in the next few minutes",
    carrier: null,
    transcript,
  });
});

test("a slow summary cannot hold the card back", async () => {
  let release;
  deps.summarize.mockReturnValue(new Promise((resolve) => (release = resolve)));
  const pending = finalize(result, ctx, deps);
  await new Promise((resolve) => setImmediate(resolve));
  expect(store.finishCall).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledTimes(1);
  release(summary());
  await pending;
  expect(publish).toHaveBeenCalledTimes(2);
});

test("a lead gets its summary, then the softphone and the owner are told", async () => {
  await finalize(result, ctx, deps);
  expect(deps.summarize).toHaveBeenCalledWith({
    client,
    config: deps.config,
    transcript,
    carrier: null,
    context: ctx,
    onUsage: expect.any(Function),
  });
  expect(store.updateSummary).toHaveBeenCalledWith(sid, {
    outcome: "lead",
    callerName: "Mike Alvarez",
    company: "Alvarez Hauling LLC",
    mcNumber: null,
    usdot: null,
    mcVerified: false,
    callbackNumber: null,
    callbackPromise: "in the next few minutes",
    details: {
      fleetSize: "2 trucks",
      equipment: "dry van",
      situation: "Unhappy with current dispatcher.",
      questions: ["What is the fee?"],
      unanswered: ["Factoring paperwork"],
      interest: "high",
    },
    summary: "Owner-operator with two dry vans.",
    script: summary().script,
  });
  expect(publish).toHaveBeenCalledTimes(2);
  expect(deps.sendLeadEmail).toHaveBeenCalledTimes(1);
  expect(deps.sendLeadEmail.mock.calls[0][0]).toMatchObject({
    call_sid: sid,
    outcome: "lead",
    caller_name: "Mike Alvarez",
    summary: "Owner-operator with two dry vans.",
  });
  expect(deps.sendLeadEmail.mock.calls[0][1]).toBe(deps.config);
});

test("a carrier the caller confirmed wins over what the summary heard", async () => {
  deps.summarize.mockResolvedValue(
    summary({ mc_number: "196058", usdot: "111", company: null }),
  );
  const carrier = {
    found: true,
    mc: "196057",
    usdot: "295923",
    legalName: "H FRED BAREFOOT TRUCKING INC",
  };
  await finalize({ ...result, carrier }, ctx, deps);
  expect(store.finishCall).toHaveBeenCalledWith(
    sid,
    expect.objectContaining({ mcNumber: "196057", mcVerified: true, carrier }),
  );
  expect(store.updateSummary).toHaveBeenCalledWith(
    sid,
    expect.objectContaining({
      mcNumber: "196057",
      usdot: "295923",
      mcVerified: true,
      company: "H FRED BAREFOOT TRUCKING INC",
    }),
  );
});

test("a looked-up carrier the caller did not confirm is not shown as verified", async () => {
  deps.summarize.mockResolvedValue(
    summary({
      carrier_confirmed: false,
      mc_number: "196075",
      usdot: null,
      company: "Alvarez Hauling LLC",
    }),
  );
  const carrier = {
    found: true,
    mc: "196057",
    usdot: "295923",
    legalName: "COMPANY A",
  };
  await finalize({ ...result, carrier }, ctx, deps);
  expect(store.updateSummary).toHaveBeenCalledWith(
    sid,
    expect.objectContaining({
      mcNumber: "196075",
      usdot: null,
      mcVerified: false,
      company: "Alvarez Hauling LLC",
    }),
  );
});

test("the summary's promise and callback number are used when it has them", async () => {
  deps.summarize.mockResolvedValue(
    summary({
      callback_promise: "tomorrow 9 to 11 AM Eastern",
      callback_number: "+15557778888",
    }),
  );
  await finalize(result, ctx, deps);
  expect(store.updateSummary).toHaveBeenCalledWith(
    sid,
    expect.objectContaining({
      callbackPromise: "tomorrow 9 to 11 AM Eastern",
      callbackNumber: "+15557778888",
    }),
  );
});

test("a failed summary still leaves a card and still alerts the owner", async () => {
  deps.summarize.mockResolvedValue(null);
  await finalize(result, ctx, deps);
  expect(store.updateSummary).toHaveBeenCalledWith(
    sid,
    expect.objectContaining({
      outcome: "lead",
      summary: expect.stringContaining("Summary unavailable"),
    }),
  );
  expect(deps.sendLeadEmail).toHaveBeenCalledTimes(1);
});

test("a summary step that throws is treated like a failed summary", async () => {
  deps.summarize.mockRejectedValue(new Error("api down"));
  await finalize(result, ctx, deps);
  expect(store.updateSummary).toHaveBeenCalledWith(
    sid,
    expect.objectContaining({
      summary: expect.stringContaining("Summary unavailable"),
    }),
  );
  expect(deps.sendLeadEmail).toHaveBeenCalledTimes(1);
});

test("without a model client the card is saved from the transcript alone", async () => {
  await finalize(result, ctx, { ...deps, client: null });
  expect(deps.summarize).not.toHaveBeenCalled();
  expect(store.finishCall).toHaveBeenCalledWith(
    sid,
    expect.objectContaining({ outcome: "lead", transcript }),
  );
  expect(deps.sendLeadEmail).toHaveBeenCalledTimes(1);
});

test("a failed email does not throw or block", async () => {
  deps.sendLeadEmail.mockRejectedValue(new Error("smtp down"));
  await expect(finalize(result, ctx, deps)).resolves.toBeUndefined();
  expect(store.finishCall).toHaveBeenCalledTimes(1);
  expect(store.updateSummary).toHaveBeenCalledTimes(1);
});

test("spam is saved but not emailed", async () => {
  deps.summarize.mockResolvedValue(summary({ outcome: "spam" }));
  await finalize(result, ctx, deps);
  expect(store.updateSummary).toHaveBeenCalledWith(
    sid,
    expect.objectContaining({ outcome: "spam" }),
  );
  expect(deps.sendLeadEmail).not.toHaveBeenCalled();
});

test("a failed session stays failed even if the summary says lead", async () => {
  await finalize({ ...result, outcome: "failed" }, ctx, deps);
  expect(store.finishCall).toHaveBeenCalledWith(
    sid,
    expect.objectContaining({ outcome: "failed" }),
  );
  expect(store.updateSummary).toHaveBeenCalledWith(
    sid,
    expect.objectContaining({ outcome: "failed" }),
  );
});

test("a caller promised a callback by the fallback line is emailed at once, before any summary", async () => {
  // The agent broke mid-call and told the caller a dispatcher would call back.
  const order = [];
  deps.sendLeadEmail.mockImplementation(async () => {
    order.push("email");
    return true;
  });
  deps.summarize.mockImplementation(async () => {
    order.push("summarize");
    return null;
  });
  await finalize({ ...result, outcome: "failed" }, ctx, deps);
  expect(order).toEqual(["email", "summarize"]);
  expect(deps.sendLeadEmail).toHaveBeenCalledTimes(1);
  expect(deps.sendLeadEmail.mock.calls[0][0]).toMatchObject({
    outcome: "failed",
    transcript,
  });
});

test("a call that was already closed is neither summarised nor emailed again", async () => {
  store.finishCall.mockResolvedValue(null);
  await finalize(result, ctx, deps);
  expect(deps.summarize).not.toHaveBeenCalled();
  expect(store.updateSummary).not.toHaveBeenCalled();
  expect(deps.sendLeadEmail).not.toHaveBeenCalled();
});

test("if the database is down the lead still reaches the owner by email, transcript included", async () => {
  store.finishCall.mockRejectedValue(new Error("connection refused"));
  await expect(finalize(result, ctx, deps)).resolves.toBeUndefined();
  expect(store.updateSummary).not.toHaveBeenCalled();
  expect(deps.sendLeadEmail).toHaveBeenCalledTimes(1);
  expect(deps.sendLeadEmail.mock.calls[0][0]).toMatchObject({
    call_sid: sid,
    from_number: "+15551230009",
    outcome: "lead",
    caller_name: "Mike Alvarez",
    summary: "Owner-operator with two dry vans.",
    transcript,
  });
});

test("if only the summary cannot be saved the owner still gets it by email", async () => {
  store.updateSummary.mockRejectedValue(new Error("connection lost"));
  await expect(finalize(result, ctx, deps)).resolves.toBeUndefined();
  expect(deps.sendLeadEmail).toHaveBeenCalledTimes(1);
  expect(deps.sendLeadEmail.mock.calls[0][0]).toMatchObject({
    outcome: "lead",
    caller_name: "Mike Alvarez",
    summary: "Owner-operator with two dry vans.",
  });
});

describe("the cost of a call", () => {
  const liveUsage = [
    {
      model: "claude-opus-5-5",
      speed: "fast",
      requests: 7,
      input: 2000,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 60000,
      output: 1000,
    },
  ];
  const timed = (callSid, fields) => ({
    call_sid: callSid,
    outcome: fields.outcome,
    started_at: new Date("2026-11-16T12:02:07Z"),
    ended_at: new Date("2026-11-16T12:03:40Z"),
  });

  test("adds the summary's tokens to the live ones and saves both cost figures", async () => {
    store.finishCall.mockImplementation(async (callSid, fields) =>
      timed(callSid, fields),
    );
    deps.summarize.mockImplementation(async ({ onUsage }) => {
      onUsage({
        model: "claude-opus-5-5",
        usage: { input_tokens: 10000, output_tokens: 2000 },
      });
      return summary();
    });
    await finalize({ ...result, usage: liveUsage }, ctx, deps);
    expect(store.saveCosts).toHaveBeenCalledTimes(1);
    const [callSid, costs] = store.saveCosts.mock.calls[0];
    expect(callSid).toBe(sid);
    expect(costs.usage).toEqual([
      liveUsage[0],
      expect.objectContaining({
        model: "claude-opus-5-5",
        speed: "standard",
        requests: 1,
        input: 10000,
        output: 2000,
      }),
    ]);
    // Live, fast: (2,000 x $8 + 60,000 x $0.40 + 1,000 x $40) / 1M = $0.080
    // Summary: (10,000 x $4 + 2,000 x $20) / 1M = $0.080
    expect(costs.claudeCost).toBeCloseTo(0.16, 6);
    // 93 seconds is two started minutes at $0.07.
    expect(costs.relayCost).toBeCloseTo(0.14, 6);
    // The usage the session handed over is not changed.
    expect(liveUsage).toHaveLength(1);
  });

  test("a call nobody spoke on still records what it cost", async () => {
    store.finishCall.mockImplementation(async (callSid, fields) =>
      timed(callSid, fields),
    );
    await finalize(
      {
        callSid: sid,
        outcome: "abandoned",
        callerSpoke: false,
        transcript: [],
        usage: liveUsage,
      },
      ctx,
      deps,
    );
    const [, costs] = store.saveCosts.mock.calls[0];
    expect(costs.usage).toEqual(liveUsage);
    expect(costs.claudeCost).toBeCloseTo(0.08, 6);
    expect(costs.relayCost).toBeCloseTo(0.14, 6);
  });

  test("failing to save the cost never loses the lead or the email", async () => {
    store.saveCosts.mockRejectedValue(new Error("db down"));
    await expect(
      finalize({ ...result, usage: liveUsage }, ctx, deps),
    ).resolves.toBeUndefined();
    expect(deps.sendLeadEmail).toHaveBeenCalledTimes(1);
  });

  test("a call that was already closed records nothing twice", async () => {
    store.finishCall.mockResolvedValue(null);
    await finalize({ ...result, usage: liveUsage }, ctx, deps);
    expect(store.saveCosts).not.toHaveBeenCalled();
  });
});
