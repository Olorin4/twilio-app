jest.mock("../../src/db", () => ({ query: jest.fn() }));
jest.mock("../../src/messageEvents", () => ({ publish: jest.fn() }));
jest.mock("../../src/receptionist/store", () => ({ finishCall: jest.fn() }));
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
  store.finishCall.mockImplementation(async (callSid, fields) => ({
    call_sid: callSid,
    ...fields,
  }));
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
  expect(publish).toHaveBeenCalledTimes(1);
});

test("a lead is saved with its summary, then published and emailed", async () => {
  await finalize(result, ctx, deps);
  expect(deps.summarize).toHaveBeenCalledWith({
    client,
    config: deps.config,
    transcript,
    carrier: null,
    context: ctx,
  });
  expect(store.finishCall).toHaveBeenCalledWith(sid, {
    outcome: "lead",
    callerName: "Mike Alvarez",
    company: "Alvarez Hauling LLC",
    mcNumber: null,
    usdot: null,
    mcVerified: false,
    callbackNumber: null,
    callbackPromise: "in the next few minutes",
    carrier: null,
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
    transcript,
  });
  expect(publish).toHaveBeenCalledTimes(1);
  expect(deps.sendLeadEmail).toHaveBeenCalledTimes(1);
  expect(deps.sendLeadEmail.mock.calls[0][0]).toMatchObject({
    call_sid: sid,
    outcome: "lead",
  });
  expect(deps.sendLeadEmail.mock.calls[0][1]).toBe(deps.config);
});

test("verified carrier data wins over what the summary heard", async () => {
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
    expect.objectContaining({
      mcNumber: "196057",
      usdot: "295923",
      mcVerified: true,
      company: "H FRED BAREFOOT TRUCKING INC",
      carrier,
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
  expect(store.finishCall).toHaveBeenCalledWith(
    sid,
    expect.objectContaining({
      callbackPromise: "tomorrow 9 to 11 AM Eastern",
      callbackNumber: "+15557778888",
    }),
  );
});

test("a failed summary still saves the card and still alerts the owner", async () => {
  deps.summarize.mockResolvedValue(null);
  await finalize(result, ctx, deps);
  expect(store.finishCall).toHaveBeenCalledWith(
    sid,
    expect.objectContaining({
      outcome: "lead",
      summary: expect.stringContaining("Summary unavailable"),
      transcript,
    }),
  );
  expect(deps.sendLeadEmail).toHaveBeenCalledTimes(1);
});

test("a summary step that throws is treated like a failed summary", async () => {
  deps.summarize.mockRejectedValue(new Error("api down"));
  await finalize(result, ctx, deps);
  expect(store.finishCall).toHaveBeenCalledWith(
    sid,
    expect.objectContaining({
      summary: expect.stringContaining("Summary unavailable"),
    }),
  );
});

test("without a model client the card is saved from the transcript alone", async () => {
  await finalize(result, ctx, { ...deps, client: null });
  expect(deps.summarize).not.toHaveBeenCalled();
  expect(store.finishCall).toHaveBeenCalledWith(
    sid,
    expect.objectContaining({ outcome: "lead", transcript }),
  );
});

test("a failed email does not throw or block", async () => {
  deps.sendLeadEmail.mockRejectedValue(new Error("smtp down"));
  await expect(finalize(result, ctx, deps)).resolves.toBeUndefined();
  expect(store.finishCall).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledTimes(1);
});

test("spam is saved but not emailed", async () => {
  deps.summarize.mockResolvedValue(summary({ outcome: "spam" }));
  await finalize(result, ctx, deps);
  expect(store.finishCall).toHaveBeenCalledWith(
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
});

test("a caller who was promised a callback by the fallback line is not forgotten", async () => {
  // The agent broke mid-call and told the caller a dispatcher would call back.
  await finalize({ ...result, outcome: "failed" }, ctx, deps);
  expect(deps.sendLeadEmail).toHaveBeenCalledTimes(1);
  expect(deps.sendLeadEmail.mock.calls[0][0]).toMatchObject({
    outcome: "failed",
  });
});

test("a call that was already closed is not emailed twice", async () => {
  store.finishCall.mockResolvedValue(null);
  await finalize(result, ctx, deps);
  expect(deps.sendLeadEmail).not.toHaveBeenCalled();
});

test("if the database is down the lead still reaches the owner by email", async () => {
  store.finishCall.mockRejectedValue(new Error("connection refused"));
  await expect(finalize(result, ctx, deps)).resolves.toBeUndefined();
  expect(deps.sendLeadEmail).toHaveBeenCalledTimes(1);
  expect(deps.sendLeadEmail.mock.calls[0][0]).toMatchObject({
    call_sid: sid,
    from_number: "+15551230009",
    outcome: "lead",
    caller_name: "Mike Alvarez",
    summary: "Owner-operator with two dry vans.",
  });
});
