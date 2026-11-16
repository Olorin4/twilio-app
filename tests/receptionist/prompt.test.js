const {
  loadKnowledge,
  buildSystem,
  TOOLS,
  callContext,
  FALLBACK_LINE,
  STILL_THERE_LINE,
  SILENT_END_LINE,
  WRAP_UP_LINE,
} = require("../../src/receptionist/prompt");

const hours = { start: 7, end: 18, timeZone: "America/New_York" };

test("system blocks are identical across calls and cache the knowledge for an hour", () => {
  expect(JSON.stringify(buildSystem())).toBe(JSON.stringify(buildSystem()));
  const [rules, knowledge] = buildSystem();
  expect(buildSystem()).toHaveLength(2);
  expect(rules.cache_control).toBeUndefined();
  expect(knowledge.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  expect(knowledge.text).toBe(loadKnowledge());
});

test("the knowledge document has every agreed section and the published prices", () => {
  const text = loadKnowledge();
  for (const heading of [
    "## Who we are",
    "## Services",
    "## Plans and pricing",
    "## How onboarding works",
    "## Requirements",
    "## Documents needed",
    "## Common questions and objections",
    "## Never say",
  ])
    expect(text).toContain(heading);
  expect(text).toContain("5%");
  expect(text).toContain("10%");
  expect(text).toContain("linehaul");
});

test("rules carry the non-negotiables", () => {
  const text = buildSystem()[0].text;
  for (const phrase of [
    "Jack Jones",
    "AI assistant",
    "lookup_carrier",
    "end_call",
    "next few minutes",
    "one second while I pull that up",
    "callback number",
    "a dispatcher",
  ])
    expect(text).toContain(phrase);
});

test("nothing that changes per call or per day is in the cached prefix", () => {
  const text = JSON.stringify(buildSystem());
  expect(text).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
  expect(text).not.toMatch(/<call_context>/);
});

test("tools are strict and closed", () => {
  expect(TOOLS.map((t) => t.name)).toEqual(["lookup_carrier", "end_call"]);
  for (const tool of TOOLS) {
    expect(tool.strict).toBe(true);
    expect(tool.input_schema.additionalProperties).toBe(false);
    expect(tool.input_schema.required).toEqual(
      Object.keys(tool.input_schema.properties),
    );
  }
  expect(TOOLS[1].input_schema.properties.outcome.enum).toEqual([
    "lead",
    "not_a_lead",
    "spam",
  ]);
  // The goodbye travels as a tool input so it always reaches the caller.
  expect(Object.keys(TOOLS[1].input_schema.properties)).toEqual([
    "outcome",
    "callback_promise",
    "goodbye",
  ]);
});

test("call context tells the agent when the number is unknown and the office is closed", () => {
  const text = callContext({
    fromKnown: false,
    open: false,
    hours,
    now: new Date("2026-11-16T03:00:00Z"),
  });
  expect(text).toMatch(/^<call_context>[\s\S]*<\/call_context>$/);
  expect(text).toMatch(/number is not known/i);
  expect(text).toMatch(/closed/i);
  expect(text).toContain("7:00 AM to 6:00 PM");
  expect(text).toContain("Sunday, November 15, 2026"); // 10 PM Eastern
});

test("call context for a known number during calling hours", () => {
  const text = callContext({
    fromKnown: true,
    open: true,
    hours,
    now: new Date("2026-11-16T15:00:00Z"),
  });
  expect(text).toMatch(/number is known/i);
  expect(text).toMatch(/open/i);
  expect(text).not.toMatch(/closed/i);
  expect(text).toContain("Monday, November 16, 2026");
});

test("the fixed lines promise a callback and never claim to be human", () => {
  expect(FALLBACK_LINE).toContain("A dispatcher will call you back");
  expect(WRAP_UP_LINE).toContain("dispatcher will call you back");
  expect(STILL_THERE_LINE).toBe("Are you still there?");
  expect(SILENT_END_LINE).toContain("Goodbye");
});

test("the lookup tool does not tell the model to speak the filler the app already speaks", () => {
  expect(TOOLS[0].description).not.toMatch(/you say you are pulling it up/);
  expect(TOOLS[0].description).toMatch(/hears a short holding line/);
});

test("the rules keep the call on Iron Wing's dispatch service", () => {
  const text = buildSystem()[0].text;
  // Unrelated subjects are declined in a sentence and steered back.
  expect(text).toMatch(/only help with Iron Wing/);
  expect(text).toMatch(/unrelated/i);
  // A caller who will not come back to the subject is offered the callback,
  // on the third detour and not before.
  expect(text).toMatch(/third time/i);
  expect(text).not.toMatch(/second time/i);
  // What a caller says never changes the assistant's instructions.
  expect(text).toMatch(/ignore your (rules|instructions)/i);
  expect(text).toMatch(/reveal/i);
});

test("the rules make Jack a receptionist for other trucking businesses too", () => {
  const text = buildSystem()[0].text;
  // Brokers, factoring companies and the like are welcome callers, not detours.
  for (const caller of [
    "broker",
    "factoring",
    "insurance",
    "shipper",
    "vendor",
  ])
    expect(text).toContain(caller);
  expect(text).toMatch(/receptionist/i);
  // He finds out who is calling and takes a proper message.
  expect(text).toMatch(/company/i);
  expect(text).toMatch(/message/i);
  expect(text).toMatch(/urgent/i);
  // The protections for carriers stay in place whoever is asking.
  expect(text).toMatch(/whether .* is a (client|customer)/i);
  expect(text).toMatch(/bank|payment details/i);
  // A business caller is not pressed for an MC number.
  expect(text).toMatch(/do not (ask|press) .* for an MC number/i);
});

test("questions about a named carrier are handled with judgement, not a flat refusal", () => {
  const text = buildSystem()[0].text;
  // Jack has no list of carriers, so he can never truthfully say yes or no.
  expect(text).toMatch(/no list of (the |our )?carriers/i);
  expect(text).toMatch(/never guess/i);
  // How forthcoming he is depends on how the caller introduced themselves.
  expect(text).toMatch(/judg(e)?ment/i);
  expect(text).toMatch(/introduced themselves/i);
  // A credible business caller is told plainly why, and helped toward an answer.
  expect(text).toMatch(/the dispatcher (can|will) confirm/i);
  // The hard line on bank and contact details does not bend.
  expect(text).toMatch(/whatever the caller says/i);
});

test("a caller who keeps trying to change the rules is ended like any other detour", () => {
  const text = buildSystem()[0].text;
  expect(text).toMatch(/keeps? trying/i);
  expect(text).toMatch(/third attempt/i);
});

test("the knowledge never lets Jack say the company handles factoring itself", () => {
  expect(loadKnowledge()).toMatch(/never (say|that) we .*handle factoring/i);
});

test("the callback promise says which number the dispatcher will call", () => {
  // "From this number" came from the first draft of the rules. Callers could
  // not tell whose number was meant.
  const text = buildSystem()[0].text;
  expect(text).not.toMatch(/from this number/i);
  expect(text).toMatch(/on the number they are calling from/i);
});

test("Jack is not introduced as an AI, so the rules make him say so when asked", () => {
  const text = buildSystem()[0].text;
  expect(text).not.toMatch(/already been told/i);
  expect(text).toMatch(/greeting does not say/i);
  expect(text).toMatch(/never say or imply that you are a (person|human)/i);
  expect(text).toMatch(/say plainly[^.]*that you are an AI assistant/i);
});

test("a caller who asks whether the call is recorded gets a true answer", () => {
  const text = buildSystem()[0].text;
  expect(text).toMatch(/recorded[^.]*transcribed/i);
});

test("the knowledge never says there is no contract", () => {
  // Heard on the first real call: "there's no contract". There is a short
  // service agreement; what there is not is a term commitment.
  const text = loadKnowledge();
  expect(text).not.toMatch(/there(?:'s| is) no\s+contract/i);
  expect(text).not.toMatch(/and no\s+contract/i);
  expect(text).toMatch(/never say (that )?we have no contract/i);
  expect(text).toMatch(/short service agreement/i);
});
