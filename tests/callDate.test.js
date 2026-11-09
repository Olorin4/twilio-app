test("call dates use calendar days in the selected time zone, including DST", () => {
  const fs = require("fs");
  const vm = require("vm");
  const path = require("path");
  const source = fs
    .readFileSync(path.join(__dirname, "../frontend/src/callDate.mjs"), "utf8")
    .replace("export function", "function");
  const formatCallDate = vm.runInNewContext(`${source}\nformatCallDate`, {
    Date,
    Intl,
    Number,
  });
  const now = new Date("2026-03-09T04:30:00Z");
  const values = [
    formatCallDate("2026-03-09T04:15:00Z", "America/New_York", now),
    formatCallDate("2026-03-08T05:30:00Z", "America/New_York", now),
    formatCallDate("2026-03-07T04:30:00Z", "America/New_York", now),
    formatCallDate("2026-03-09T04:15:00Z", "Asia/Tokyo", now),
  ];
  expect(values[0]).toMatch(/^Today,/);
  expect(values[1]).toMatch(/^Yesterday,/);
  expect(values[2]).not.toMatch(/^(Today|Yesterday),/);
  expect(values[3]).toMatch(/^Today,/);
});
