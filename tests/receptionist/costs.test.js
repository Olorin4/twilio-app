const {
  addUsage,
  claudeCost,
  relayCost,
} = require("../../src/receptionist/costs");

const message = (model, usage) => ({ model, usage });
const opusTurn = {
  input_tokens: 1000,
  output_tokens: 500,
  cache_read_input_tokens: 10000,
  cache_creation_input_tokens: 9500,
  cache_creation: {
    ephemeral_5m_input_tokens: 0,
    ephemeral_1h_input_tokens: 9500,
  },
};

test("usage adds up per model and speed", () => {
  const usage = [];
  addUsage(usage, message("claude-opus-5-5", opusTurn));
  addUsage(usage, message("claude-opus-5-5", opusTurn));
  addUsage(usage, message("claude-opus-5-5", { ...opusTurn, speed: "fast" }));
  expect(usage).toEqual([
    {
      model: "claude-opus-5-5",
      speed: "standard",
      requests: 2,
      input: 2000,
      cacheWrite5m: 0,
      cacheWrite1h: 19000,
      cacheRead: 20000,
      output: 1000,
    },
    {
      model: "claude-opus-5-5",
      speed: "fast",
      requests: 1,
      input: 1000,
      cacheWrite5m: 0,
      cacheWrite1h: 9500,
      cacheRead: 10000,
      output: 500,
    },
  ]);
});

test("a response without usage adds nothing", () => {
  const usage = [];
  addUsage(usage, { model: "claude-opus-5-5" });
  addUsage(usage, undefined);
  expect(usage).toEqual([]);
});

test("Opus is priced from Anthropic's list prices", () => {
  const usage = [];
  addUsage(usage, message("claude-opus-5-5", opusTurn));
  // 1,000 x $4 + 10,000 x $0.20 + 9,500 x $8 + 500 x $20, per million.
  expect(claudeCost(usage)).toBeCloseTo(0.092, 6);
});

test("fast mode doubles every part of the price", () => {
  const usage = [];
  addUsage(usage, message("claude-opus-5-5", { ...opusTurn, speed: "fast" }));
  expect(claudeCost(usage)).toBeCloseTo(0.184, 6);
});

test("five-minute cache writes cost less than one-hour ones", () => {
  const usage = [];
  addUsage(
    usage,
    message("claude-opus-5-5", {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
      cache_creation: {
        ephemeral_5m_input_tokens: 1_000_000,
        ephemeral_1h_input_tokens: 0,
      },
    }),
  );
  expect(claudeCost(usage)).toBeCloseTo(5, 6);
});

test("a cache write with no breakdown is priced as one hour, the kind this app writes", () => {
  const usage = [];
  addUsage(
    usage,
    message("claude-opus-5-5", {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
    }),
  );
  expect(claudeCost(usage)).toBeCloseTo(8, 6);
});

test.each([
  ["claude-sonnet-5-5", 2 + 0.1 + 10],
  ["claude-haiku-5-5", 0.1 + 0.01 + 0.5],
])("%s has its own prices", (model, expected) => {
  const usage = [];
  addUsage(
    usage,
    message(model, {
      input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    }),
  );
  expect(claudeCost(usage)).toBeCloseTo(expected, 6);
});

test("a model without a known price gives no cost instead of a guess", () => {
  const usage = [];
  addUsage(usage, message("claude-opus-5-5", opusTurn));
  addUsage(usage, message("claude-something-new", opusTurn));
  expect(claudeCost(usage)).toBeNull();
});

test("no model requests cost nothing", () => {
  expect(claudeCost([])).toBe(0);
  expect(claudeCost(undefined)).toBe(0);
});

test("ConversationRelay is charged per started minute", () => {
  expect(relayCost(93, 0.07)).toBeCloseTo(0.14, 6);
  expect(relayCost(60, 0.07)).toBeCloseTo(0.07, 6);
  expect(relayCost(61, 0.07)).toBeCloseTo(0.14, 6);
  expect(relayCost(0, 0.07)).toBe(0);
  expect(relayCost(null, 0.07)).toBeNull();
});
