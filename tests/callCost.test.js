const fs = require("fs");
const vm = require("vm");
const path = require("path");
const source = fs
  .readFileSync(path.join(__dirname, "../frontend/src/callCost.mjs"), "utf8")
  .replace(/export (function|const)/g, "$1");
const { callCost } = vm.runInNewContext(`${source}\n({ callCost })`);

test("an ordinary call shows Twilio's charge", () => {
  expect(callCost({ cost: { unit: "USD", twilio: 0.017 } })).toEqual({
    label: "$0.017",
    breakdown: "Twilio call $0.017",
  });
});

test("a call Jack answered shows the total and what it is made of", () => {
  expect(
    callCost({
      cost: { unit: "USD", twilio: 0.045, relay: 0.14, claude: 0.2134 },
    }),
  ).toEqual({
    label: "≈ $0.40",
    breakdown:
      "Twilio call $0.045 · ConversationRelay ≈ $0.14 · Claude ≈ $0.21 · ≈ marks an estimate from list prices",
  });
});

test.each([
  [0, "$0.00"],
  [0.0085, "$0.009"],
  [0.099, "$0.099"],
  [0.1, "$0.10"],
  [1.5, "$1.50"],
  [12.345, "$12.35"],
])("an amount of %s reads %s", (twilio, label) => {
  expect(callCost({ cost: { unit: "USD", twilio } }).label).toBe(label);
});

test("amounts sent as text are read as numbers", () => {
  expect(
    callCost({ cost: { unit: "USD", twilio: "0.01700", relay: "0.14000" } })
      .label,
  ).toBe("≈ $0.16");
});

test.each([
  [undefined],
  [{}],
  [{ cost: null }],
  [{ cost: { unit: "USD", twilio: null } }],
  [{ cost: { unit: "EUR", twilio: 0.02 } }],
  [{ cost: { unit: "USD", twilio: "n/a" } }],
])("nothing is shown for %j", (row) => {
  expect(callCost(row)).toBeNull();
});
