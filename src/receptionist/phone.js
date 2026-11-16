/* Whether a caller ID is a number someone can actually be called back on.
When a caller withholds their number, Twilio may send the word "anonymous"
or one of a few pseudo-numbers that look like real E.164 numbers. */

const E164 = /^\+[1-9]\d{7,14}$/;
const WITHHELD = new Set([
  "+266696687", // ANONYMOUS
  "+7378742833", // RESTRICTED
  "+2562533", // BLOCKED
  "+8656696", // UNKNOWN
  "+86282452253", // UNAVAILABLE
]);

// The number in E.164 form, or null when it cannot be called back.
function callableNumber(value) {
  const number = typeof value === "string" ? value.trim() : "";
  return E164.test(number) && !WITHHELD.has(number) ? number : null;
}

module.exports = { callableNumber };
