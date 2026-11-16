const { getConfig, isOpen } = require("../../src/receptionist/config");

test("defaults are safe: disabled, test mode on, owner's voice", () => {
  const c = getConfig({});
  expect(c.enabled).toBe(false);
  expect(c.testMode).toBe(true);
  expect(c.voice).toBe("7EzWGsX10sAS4c9m9cPf");
  expect(c.sayVoice).toBeNull();
  expect(c.liveModel).toBe("claude-opus-5-5");
  expect(c.liveEffort).toBe("low");
  expect(c.liveThinking).toBe("default");
  expect(c.liveSpeed).toBe("standard");
  expect(c.summaryModel).toBe("claude-opus-5-5");
  expect(c.hours).toEqual({ start: 7, end: 18, timeZone: "America/New_York" });
  expect(c.dailyLimit).toBe(3);
  expect(c.maxCallSeconds).toBe(480);
  expect(c.alertEmail).toBeNull();
  expect(c.smtp).toEqual({
    host: null,
    port: 587,
    user: null,
    pass: null,
    from: null,
  });
});

test("the feature and live mode need explicit values", () => {
  const c = getConfig({
    RECEPTIONIST_ENABLED: "true",
    RECEPTIONIST_TEST_MODE: "false",
  });
  expect(c.enabled).toBe(true);
  expect(c.testMode).toBe(false);
  expect(getConfig({ RECEPTIONIST_ENABLED: "yes" }).enabled).toBe(false);
  expect(getConfig({ RECEPTIONIST_TEST_MODE: "off" }).testMode).toBe(true);
});

test("test callers are trimmed into a set", () => {
  const c = getConfig({
    RECEPTIONIST_TEST_CALLERS: " +15551230001, +15551230002 ",
  });
  expect([...c.testCallers]).toEqual(["+15551230001", "+15551230002"]);
  expect(getConfig({}).testCallers.size).toBe(0);
});

test("invalid numbers fall back to defaults instead of NaN", () => {
  expect(getConfig({ RECEPTIONIST_DAILY_LIMIT: "abc" }).dailyLimit).toBe(3);
  expect(getConfig({ RECEPTIONIST_HOURS_START: "-2" }).hours.start).toBe(7);
  expect(getConfig({ RECEPTIONIST_MAX_CALL_SECONDS: "" }).maxCallSeconds).toBe(
    480,
  );
});

test("unknown option values fall back to the defaults", () => {
  const c = getConfig({
    RECEPTIONIST_LIVE_THINKING: "maybe",
    RECEPTIONIST_LIVE_SPEED: "ludicrous",
  });
  expect(c.liveThinking).toBe("default");
  expect(c.liveSpeed).toBe("standard");
});

test("isOpen uses the configured zone and a half-open range", () => {
  const hours = { start: 7, end: 18, timeZone: "America/New_York" };
  expect(isOpen(new Date("2026-11-16T12:00:00Z"), hours)).toBe(true); // 07:00 ET
  expect(isOpen(new Date("2026-11-16T23:00:00Z"), hours)).toBe(false); // 18:00 ET
  expect(isOpen(new Date("2026-11-16T11:59:00Z"), hours)).toBe(false); // 06:59 ET
});
