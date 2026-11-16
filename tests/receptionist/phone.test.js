const { callableNumber } = require("../../src/receptionist/phone");

test.each([
  ["+15551230009", "+15551230009"],
  [" +15551230009 ", "+15551230009"],
  ["anonymous", null],
  ["", null],
  [undefined, null],
  ["client:operator", null],
  // Twilio delivers a withheld caller ID as one of these pseudo-numbers.
  ["+266696687", null], // ANONYMOUS
  ["+7378742833", null], // RESTRICTED
  ["+86282452253", null], // UNAVAILABLE
  ["+2562533", null], // BLOCKED
  ["+8656696", null], // UNKNOWN
])("callableNumber(%j) is %j", (input, out) =>
  expect(callableNumber(input)).toBe(out),
);
