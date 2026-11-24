const fs = require("fs");
const vm = require("vm");
const path = require("path");
const source = fs
  .readFileSync(path.join(__dirname, "../frontend/src/timeline.mjs"), "utf8")
  .replace(/export (function|const)/g, "$1");
const { isTimelinePhone, relativeTime } = vm.runInNewContext(
  `${source}; ({ isTimelinePhone, relativeTime })`,
);

describe("isTimelinePhone", () => {
  test("accepts E.164 numbers only", () => {
    expect(isTimelinePhone("+15551234567")).toBe(true);
    expect(isTimelinePhone("5551234567")).toBe(false);
    expect(isTimelinePhone("+1 555 123 4567")).toBe(false);
    expect(isTimelinePhone("client:abc")).toBe(false);
    expect(isTimelinePhone("anonymous")).toBe(false);
    expect(isTimelinePhone("+1234567")).toBe(false);
    expect(isTimelinePhone(null)).toBe(false);
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");
  const ago = (s) => new Date(now - s * 1000).toISOString();
  test("formats", () => {
    expect(relativeTime(ago(10), now)).toBe("just now");
    expect(relativeTime(ago(60), now)).toBe("1 minute ago");
    expect(relativeTime(ago(300), now)).toBe("5 minutes ago");
    expect(relativeTime(ago(7200), now)).toBe("2 hours ago");
    expect(relativeTime(ago(86400 * 3), now)).toBe("3 days ago");
    expect(relativeTime(ago(86400 * 14), now)).toBe("2 weeks ago");
    expect(relativeTime("nope", now)).toBe("");
  });
  test("a little clock skew into the future is just now; far future is not", () => {
    expect(relativeTime(ago(-30), now)).toBe("just now");
    expect(relativeTime(ago(-300), now)).toBe("just now");
    expect(relativeTime(ago(-301), now)).toBe("in the future");
    expect(relativeTime(ago(-86400), now)).toBe("in the future");
  });
});
