const fs = require("fs");
const vm = require("vm");
const path = require("path");
const source = fs
  .readFileSync(path.join(__dirname, "../frontend/src/leadCard.mjs"), "utf8")
  .replace(/export (function|const)/g, "$1");
const { leadTitle, carrierLine, badge, callbackTarget, promiseLine, unread } =
  vm.runInNewContext(
    `${source}\n({ leadTitle, carrierLine, badge, callbackTarget, promiseLine, unread })`,
  );

test.each([
  [
    { callerName: "Mike Alvarez", company: "Alvarez Hauling LLC" },
    "Mike Alvarez · Alvarez Hauling LLC",
  ],
  [{ callerName: "Mike Alvarez" }, "Mike Alvarez"],
  [
    { company: "Alvarez Hauling LLC", from: "+15551230009" },
    "Alvarez Hauling LLC",
  ],
  [{ callbackNumber: "+15551230009" }, "+15551230009"],
  [{ from: "+15557770000" }, "+15557770000"],
  [{ from: "anonymous" }, "Unknown caller"],
  [{}, "Unknown caller"],
])("leadTitle(%j)", (lead, out) => expect(leadTitle(lead)).toBe(out));

test("carrier line shows the check result", () => {
  expect(
    carrierLine({
      mcNumber: "1234567",
      mcVerified: true,
      carrier: { city: "DALLAS", state: "TX", powerUnits: 2, since: 2025 },
    }),
  ).toBe("MC 1234567 ✓ verified · Dallas, TX · 2 trucks · USDOT since 2025");
  expect(carrierLine({ mcNumber: "1234567", mcVerified: false })).toBe(
    "MC 1234567 (not verified)",
  );
  expect(carrierLine({})).toBe("No authority yet");
});

test("carrier line copes with a USDOT-only carrier and sparse records", () => {
  expect(
    carrierLine({
      usdot: "295917",
      mcVerified: true,
      carrier: { city: "ALUM BANK", state: "PA", powerUnits: 1 },
    }),
  ).toBe("USDOT 295917 ✓ verified · Alum Bank, PA · 1 truck");
  expect(
    carrierLine({ mcNumber: "55", mcVerified: true, carrier: { state: "TX" } }),
  ).toBe("MC 55 ✓ verified · TX");
  expect(carrierLine({ mcNumber: "55", mcVerified: true, carrier: null })).toBe(
    "MC 55 ✓ verified",
  );
});

test.each([
  ["lead", "NEW LEAD"],
  ["not_a_lead", "MESSAGE"],
  ["failed", "AGENT FAILED"],
  ["abandoned", "ABANDONED"],
  ["spam", "SPAM"],
  [undefined, "CALL"],
])("badge for %s", (outcome, label) => expect(badge({ outcome })).toBe(label));

test("a blocked caller with no callback number cannot be dialled", () => {
  expect(callbackTarget({ from: "anonymous" })).toBeNull();
  expect(
    callbackTarget({ from: "anonymous", callbackNumber: "+15551230009" }),
  ).toBe("+15551230009");
  expect(
    callbackTarget({ from: "+15557770000", callbackNumber: "call my cell" }),
  ).toBe("+15557770000");
  expect(callbackTarget({})).toBeNull();
});

test("the promise line says what the caller was told", () => {
  expect(promiseLine({ callbackPromise: "in the next few minutes" })).toBe(
    "Promised: in the next few minutes",
  );
  expect(promiseLine({ outcome: "lead" })).toBe("No callback time promised");
});

test("unread counts only new cards that are owed a callback", () => {
  expect(unread({ status: "new", outcome: "lead" })).toBe(true);
  expect(unread({ status: "new", outcome: "failed" })).toBe(true);
  expect(unread({ status: "new", outcome: "spam" })).toBe(false);
  expect(unread({ status: "called", outcome: "lead" })).toBe(false);
});
