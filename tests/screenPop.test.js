const fs = require("fs");
const vm = require("vm");
const path = require("path");
const read = (f) =>
  fs.readFileSync(path.join(__dirname, "../frontend/src", f), "utf8");
const source =
  `${read("timeline.mjs")}\n${read("screenPop.mjs").replace(/^import .*$/gm, "")}`.replace(
    /export (function|const)/g,
    "$1",
  );
const { shouldFetch, popLine, latestBefore, isCurrent } = vm.runInNewContext(
  `${source}; ({ shouldFetch, popLine, latestBefore, isCurrent })`,
);

const NOW = Date.parse("2026-11-24T12:00:00Z");
const ago = (s) => new Date(NOW - s * 1000).toISOString();

describe("shouldFetch", () => {
  test("only for a valid phone number", () => {
    for (const bad of ["anonymous", "client:abc", "", "+1 555", null])
      expect(shouldFetch(bad)).toBe(false);
    expect(shouldFetch("+15550100123")).toBe(true);
  });
});

describe("latestBefore", () => {
  const ringing = { kind: "call", at: ago(5), summary: "Incoming call" };
  const old = { kind: "text", at: ago(86400), summary: "Texted" };
  test("skips the ringing call itself", () => {
    expect(latestBefore([ringing, old], NOW)).toBe(old);
  });
  test("skips a call dated within 60 s before ring time or later", () => {
    const edge = { kind: "call", at: ago(59), summary: "x" };
    const future = { kind: "call", at: ago(-10), summary: "y" };
    expect(latestBefore([future, edge, old], NOW)).toBe(old);
  });
  test("keeps a call older than 60 s and recent non-call entries", () => {
    const prior = { kind: "call", at: ago(61), summary: "Missed" };
    expect(latestBefore([prior], NOW)).toBe(prior);
    const text = { kind: "text", at: ago(2), summary: "Texted" };
    expect(latestBefore([text], NOW)).toBe(text);
  });
  test("returns null when nothing remains", () => {
    expect(latestBefore([ringing], NOW)).toBeNull();
    expect(latestBefore([], NOW)).toBeNull();
    expect(latestBefore(undefined, NOW)).toBeNull();
  });
});

describe("popLine", () => {
  const entry = { kind: "text", at: ago(7200), summary: "Texted: see you" };
  const contact = { name: "Ann Lee", company: null };
  test("name with last entry", () => {
    expect(popLine({ contact, entries: [entry] }, NOW, NOW)).toBe(
      "Ann Lee · Last: Texted: see you · 2 hours ago",
    );
  });
  test("no contact with last entry", () => {
    expect(popLine({ contact: null, entries: [entry] }, NOW, NOW)).toBe(
      "Last: Texted: see you · 2 hours ago",
    );
  });
  test("name only when there are no entries", () => {
    expect(popLine({ contact, entries: [] }, NOW, NOW)).toBe("Ann Lee");
  });
  test("null with neither", () => {
    expect(popLine({ contact: null, entries: [] }, NOW, NOW)).toBeNull();
    expect(popLine(null, NOW, NOW)).toBeNull();
  });
  test("ignores the ringing call", () => {
    const ringing = { kind: "call", at: ago(3), summary: "Incoming call" };
    expect(popLine({ contact, entries: [ringing, entry] }, NOW, NOW)).toBe(
      "Ann Lee · Last: Texted: see you · 2 hours ago",
    );
  });
});

describe("isCurrent", () => {
  test("a result for an earlier call is dropped", () => {
    const callA = {};
    const callB = {};
    expect(isCurrent(callA, callB)).toBe(false);
    expect(isCurrent(callB, callB)).toBe(true);
    expect(isCurrent(callA, null)).toBe(false);
  });
});
