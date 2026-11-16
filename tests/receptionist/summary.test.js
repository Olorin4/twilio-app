const { getConfig } = require("../../src/receptionist/config");
const { loadKnowledge } = require("../../src/receptionist/prompt");
const { summarize, LeadSummary } = require("../../src/receptionist/summary");

const config = getConfig({});
const transcript = [
  { role: "agent", text: "Thanks for calling." },
  { role: "caller", text: "I need a dispatcher for my dry van" },
];
const context = { callSid: `CA${"1".repeat(32)}`, from: "+15551230009" };
const parsed = {
  outcome: "lead",
  caller_name: null,
  company: null,
  mc_number: null,
  usdot: null,
  callback_number: null,
  fleet_size: null,
  equipment: "dry van",
  situation: "Wants dispatch.",
  questions: [],
  unanswered: [],
  interest: "medium",
  callback_promise: null,
  carrier_confirmed: false,
  summary: "Caller wants dispatch for a dry van.",
  script: { opener: "Hi.", points: [], objections: [], next_step: "Sign up" },
};
const clientReturning = (response) => ({
  messages: { parse: jest.fn().mockResolvedValue(response) },
});

beforeEach(() => jest.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

test("the schema accepts a complete summary and rejects an unknown outcome", () => {
  expect(LeadSummary.safeParse(parsed).success).toBe(true);
  expect(LeadSummary.safeParse({ ...parsed, outcome: "failed" }).success).toBe(
    false,
  );
});

test("one structured request carries the knowledge, the transcript and the carrier", async () => {
  const client = clientReturning({
    stop_reason: "end_turn",
    parsed_output: parsed,
  });
  const carrier = { found: true, legalName: "SMITH TRUCKING", mc: "196057" };
  const out = await summarize({ client, config, transcript, carrier, context });
  expect(out).toEqual(parsed);
  expect(client.messages.parse).toHaveBeenCalledTimes(1);
  const request = client.messages.parse.mock.calls[0][0];
  expect(request.model).toBe("claude-opus-5-5");
  expect(request.max_tokens).toBe(16000);
  // The owner's alert waits on this request, so it gets one bounded attempt.
  expect(client.messages.parse.mock.calls[0][1]).toEqual({
    timeout: 40_000,
    maxRetries: 0,
  });
  expect(request.output_config.format).toBeDefined();
  // The script is spoken by the dispatcher, who is not Jack: on the first
  // real call the opener read "I said I'd call you back".
  const instructions = request.system[0].text;
  expect(instructions).toMatch(
    /the dispatcher is a different person from Jack/i,
  );
  expect(instructions).toMatch(/Jack said (a dispatcher|I) would call/i);
  expect(instructions).toMatch(/no contract/i);
  expect(JSON.stringify(request.system)).toContain(
    JSON.stringify(loadKnowledge()).slice(1, 80),
  );
  const user = JSON.stringify(request.messages);
  expect(user).toContain("I need a dispatcher for my dry van");
  expect(user).toContain("SMITH TRUCKING");
  expect(user).toContain("+15551230009");
});

test.each([
  ["a refusal", { stop_reason: "refusal", parsed_output: null }],
  ["an unparseable answer", { stop_reason: "end_turn", parsed_output: null }],
  ["a cut-off answer", { stop_reason: "max_tokens", parsed_output: parsed }],
])("%s yields null", async (_name, response) => {
  expect(
    await summarize({
      client: clientReturning(response),
      config,
      transcript,
      carrier: null,
      context,
    }),
  ).toBeNull();
});

test("an API error yields null instead of throwing", async () => {
  const client = {
    messages: { parse: jest.fn().mockRejectedValue(new Error("529")) },
  };
  expect(
    await summarize({ client, config, transcript, carrier: null, context }),
  ).toBeNull();
});

test("the summary request reports the tokens it used, even when it gives no summary", async () => {
  const onUsage = jest.fn();
  const response = {
    stop_reason: "end_turn",
    parsed_output: parsed,
    model: "claude-opus-5-5",
    usage: { input_tokens: 9800, output_tokens: 1500 },
  };
  await summarize({
    client: clientReturning(response),
    config,
    transcript,
    carrier: null,
    context,
    onUsage,
  });
  expect(onUsage).toHaveBeenCalledWith(response);
  const refused = { ...response, stop_reason: "refusal", parsed_output: null };
  onUsage.mockClear();
  expect(
    await summarize({
      client: clientReturning(refused),
      config,
      transcript,
      carrier: null,
      context,
      onUsage,
    }),
  ).toBeNull();
  expect(onUsage).toHaveBeenCalledWith(refused);
});
