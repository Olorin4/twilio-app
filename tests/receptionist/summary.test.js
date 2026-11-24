const { getConfig } = require("../../src/receptionist/config");
const { summarize, LeadSummary } = require("../../src/receptionist/summary");
const { JACK } = require("../../src/receptionist/seed/jack");

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
  const out = await summarize({
    client,
    config,
    transcript,
    carrier,
    context,
    profile: JACK,
  });
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
    JSON.stringify(JACK.knowledge).slice(1, 80),
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
      profile: JACK,
    }),
  ).toBeNull();
});

test("an API error yields null instead of throwing", async () => {
  const client = {
    messages: { parse: jest.fn().mockRejectedValue(new Error("529")) },
  };
  expect(
    await summarize({
      client,
      config,
      transcript,
      carrier: null,
      context,
      profile: JACK,
    }),
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
    profile: JACK,
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
      profile: JACK,
      onUsage,
    }),
  ).toBeNull();
  expect(onUsage).toHaveBeenCalledWith(refused);
});

describe("summaries per agent profile", () => {
  const support = {
    id: "00000000-0000-4000-8000-0000000000b1",
    workspaceId: "00000000-0000-4000-8000-000000000002",
    kind: "support",
    name: "KelevoTMS support",
    personaName: "Ava",
    companyName: "KelevoTMS",
    greeting: "Thanks for calling KelevoTMS support. This is Ava.",
    instructions: "You are Ava, KelevoTMS's support line.",
    knowledge: "KelevoTMS resets passwords from the login screen.",
  };
  const dispatcher = {
    ...support,
    kind: "dispatcher",
    personaName: "Sam",
    companyName: "Northline Dispatch",
    knowledge: "Northline dispatches reefers.",
  };
  const request = async (profile) => {
    const client = clientReturning({
      stop_reason: "end_turn",
      parsed_output: parsed,
    });
    await summarize({
      client,
      config,
      transcript,
      carrier: null,
      context,
      profile,
    });
    return client.messages.parse.mock.calls[0][0];
  };

  // Today's INSTRUCTIONS, copied verbatim from summary.js before agent
  // profiles: Jack's summary prompt must not change by a character.
  const TODAY = `You prepare a dispatcher at Iron Wing Dispatching for a callback. A caller has just spoken with Jack, the company's AI phone assistant. From the transcript, the FMCSA carrier record (when there is one) and the company knowledge document, fill in the lead card.

The dispatcher reads this in the minute before calling back, so be specific and brief, and write only what the material supports:
- Take facts about the caller only from the transcript and the carrier record. Use null (or "unknown" for interest) when something was not said. Do not guess a name, company or number. The transcript comes from speech recognition, so names and numbers may be misspelled; when the carrier record gives the company name or MC number, prefer it.
- outcome: "lead" for a carrier or owner-operator interested in dispatch, "not_a_lead" for anyone else with a genuine reason to call (existing customer, driver, broker, vendor), "spam" for sales calls and robocalls.
- callback_number: only a number the caller gave during the call, in the form +1XXXXXXXXXX. Otherwise null.
- callback_promise: what Jack told the caller about when they will be called back, or null if nothing was promised.
- carrier_confirmed: true only if there is a carrier record and the caller agreed that it is their company. False if they said it was not them, never answered, or there is no record.
- questions: what the caller asked or objected to. unanswered: the questions Jack could not answer.
- summary: three to five short lines on who they are, what they run and what they want.
- script: a suggested callback for the dispatcher, in the dispatcher's own first-person voice. The dispatcher is a different person from Jack and was not on the call: "I" in the script is the dispatcher, and anything said or promised on the call was said by Jack. So write "Jack said a dispatcher would call you back", never "I said I would call". opener greets the caller by name if known and refers to their call with Jack. points are the two to four things worth saying to this caller. objections pairs each concern they raised with an answer. next_step is the one thing to ask for at the end of the call.
- Every statement about services, plans or prices in the script must come from the knowledge document below, in its wording: for example "no term commitment", never "no contract". If Jack said something on the call that the document does not support, do not repeat it in the script. If the document does not cover something the caller asked, do not invent an answer: say in the script that the dispatcher should answer it personally.
- For a caller who is not a lead (a broker, a factoring company, an insurance agent, a shipper, a vendor, an existing carrier or a driver), the summary says who they are, which company they are with, what they need, any reference they gave (a load number, a carrier's name, a deadline) and whether it is urgent. Put the company in the company field. Keep the script to what the dispatcher should do on the callback; do not write a sales pitch.`;

  test("the summary schema takes the kind's outcomes", async () => {
    const outcome = (req) =>
      req.output_config.format.schema.properties.outcome.enum;
    expect(outcome(await request(dispatcher))).toEqual([
      "message",
      "urgent",
      "spam",
    ]);
    expect(outcome(await request(support))).toEqual([
      "support_request",
      "not_support",
      "spam",
    ]);
    expect(outcome(await request(JACK))).toEqual([
      "lead",
      "not_a_lead",
      "spam",
    ]);
  });

  test("the summary prompt uses the profile", async () => {
    const req = await request(support);
    const system = JSON.stringify(req.system);
    expect(system).toContain("Ava");
    expect(system).toContain("KelevoTMS");
    expect(system).toContain(support.knowledge);
    expect(system).not.toMatch(/Iron Wing/);
    expect(system).not.toMatch(/Jack/);
    // The transcript is labelled with the persona, and a support line has
    // no carrier record to offer.
    const user = JSON.stringify(req.messages);
    expect(user).toContain("Ava: Thanks for calling.");
    expect(user).not.toMatch(/Jack|FMCSA/);
    // A message card, not a sales script.
    expect(req.system[0].text).not.toMatch(/sales pitch|lead card/);
  });

  test("a dispatcher's prompt names its own company and persona", async () => {
    const req = await request(dispatcher);
    const system = JSON.stringify(req.system);
    expect(system).toContain("Sam");
    expect(system).toContain("Northline Dispatch");
    expect(system).toContain(dispatcher.knowledge);
    expect(system).not.toMatch(/Iron Wing|Jack/);
    expect(req.system[0].text).toMatch(/urgent/);
  });

  test("Jack's summary instructions are unchanged", async () => {
    const req = await request(JACK);
    expect(req.system[0].text).toBe(TODAY);
    expect(req.system[1].text).toBe(
      `<knowledge_document>\n${JACK.knowledge}\n</knowledge_document>`,
    );
  });

  test("a receptionist profile gets today's instructions with its own names", async () => {
    const req = await request({
      ...support,
      kind: "receptionist",
      personaName: "Rita",
      companyName: "Bluegrass Freight",
    });
    expect(req.system[0].text).toBe(
      TODAY.replaceAll("Iron Wing Dispatching", "Bluegrass Freight").replaceAll(
        "Jack",
        "Rita",
      ),
    );
  });

  test("an empty knowledge document still makes a valid request", async () => {
    const req = await request({ ...support, knowledge: "" });
    for (const block of req.system) expect(block.text.trim()).not.toBe("");
    expect(JSON.stringify(req.system)).not.toMatch(/cache_control/);
  });

  test("without a profile there is no summary and no request", async () => {
    const client = clientReturning({
      stop_reason: "end_turn",
      parsed_output: parsed,
    });
    expect(
      await summarize({ client, config, transcript, carrier: null, context }),
    ).toBeNull();
    expect(client.messages.parse).not.toHaveBeenCalled();
  });
});
