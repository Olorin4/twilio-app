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
