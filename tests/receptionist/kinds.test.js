const {
  KINDS,
  outcomesFor,
  toolsFor,
  EMAILED_OUTCOMES,
  defaultDailyLimit,
} = require("../../src/receptionist/kinds");
const legacyTools = require("./fixtures/legacy-tools.json");

const endCall = (kind) => toolsFor(kind).find((t) => t.name === "end_call");

test("the three kinds", () => {
  expect(KINDS).toEqual(["receptionist", "dispatcher", "support"]);
});

test("each kind has its outcomes", () => {
  expect(outcomesFor("receptionist")).toEqual(["lead", "not_a_lead", "spam"]);
  expect(outcomesFor("dispatcher")).toEqual(["message", "urgent", "spam"]);
  expect(outcomesFor("support")).toEqual([
    "support_request",
    "not_support",
    "spam",
  ]);
});

test("an unknown kind is an error, not a silent default", () => {
  expect(() => outcomesFor("sales")).toThrow(/kind/);
  expect(() => toolsFor("sales")).toThrow(/kind/);
});

test("support has no carrier lookup", () => {
  expect(toolsFor("support").map((t) => t.name)).toEqual(["end_call"]);
  expect(toolsFor("receptionist").map((t) => t.name)).toEqual([
    "lookup_carrier",
    "end_call",
  ]);
  expect(toolsFor("dispatcher").map((t) => t.name)).toEqual([
    "lookup_carrier",
    "end_call",
  ]);
});

test("end_call only offers the kind's outcomes", () => {
  for (const kind of KINDS) {
    const outcome = endCall(kind).input_schema.properties.outcome;
    expect(outcome.enum).toEqual(outcomesFor(kind));
    // The description explains every outcome on offer, and no other.
    for (const o of outcomesFor(kind))
      expect(outcome.description).toContain(`${o}:`);
    for (const other of KINDS.filter((k) => k !== kind))
      for (const o of outcomesFor(other).filter(
        (x) => !outcomesFor(kind).includes(x),
      ))
        expect(outcome.description).not.toContain(`${o}:`);
  }
});

test("every kind's tools are strict and closed", () => {
  for (const kind of KINDS)
    for (const tool of toolsFor(kind)) {
      expect(tool.strict).toBe(true);
      expect(tool.input_schema.additionalProperties).toBe(false);
      expect(tool.input_schema.required).toEqual(
        Object.keys(tool.input_schema.properties),
      );
    }
});

test("Jack's receptionist tools are exactly today's", () => {
  expect(toolsFor("receptionist")).toEqual(legacyTools);
});

test("a support agent's tools never mention dispatchers or Iron Wing", () => {
  const text = JSON.stringify(toolsFor("support"));
  expect(text).not.toMatch(/dispatch/i);
  expect(text).not.toMatch(/Iron Wing/);
});

test("emailed outcomes", () => {
  expect(EMAILED_OUTCOMES).toEqual([
    "lead",
    "not_a_lead",
    "message",
    "urgent",
    "support_request",
  ]);
});

test("receptionists use the configured daily limit, other kinds 20", () => {
  expect(defaultDailyLimit("receptionist", { dailyLimit: 3 })).toBe(3);
  expect(defaultDailyLimit("receptionist", { dailyLimit: 7 })).toBe(7);
  expect(defaultDailyLimit("receptionist", {})).toBe(3);
  expect(defaultDailyLimit("dispatcher", { dailyLimit: 3 })).toBe(20);
  expect(defaultDailyLimit("support", { dailyLimit: 3 })).toBe(20);
});
