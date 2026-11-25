const fs = require("fs");
const vm = require("vm");
const path = require("path");
const source = fs
  .readFileSync(path.join(__dirname, "../frontend/src/callerLines.mjs"), "utf8")
  .replace(/export (function|const)/g, "$1");
const { callerLines } = vm.runInNewContext(`${source}\n({ callerLines })`);
const plain = (value) => JSON.parse(JSON.stringify(value));

const IRON = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const number = (id, phone, extra = {}) => ({
  id,
  phone_number: phone,
  voice_enabled: true,
  label: null,
  active: false,
  ...extra,
});

test("Iron Wing lists the legacy number first and it is active when no line is chosen", () => {
  const lines = callerLines({
    workspaceId: IRON,
    ironWingId: IRON,
    legacyPhone: "+18178653016",
    connections: [
      { numbers: [number("n1", "+18176235160", { label: "Manager" })] },
    ],
  });
  expect(plain(lines)).toEqual([
    {
      value: "legacy",
      phone: "+18178653016",
      text: "+18178653016",
      active: true,
    },
    {
      value: "n1",
      phone: "+18176235160",
      text: "Manager · +18176235160",
      active: false,
    },
  ]);
});

test("a chosen line is active instead of the legacy number", () => {
  const lines = callerLines({
    workspaceId: IRON,
    ironWingId: IRON,
    legacyPhone: "+18178653016",
    connections: [
      { numbers: [number("n1", "+18176235160", { active: true })] },
    ],
  });
  expect(plain(lines).map((line) => [line.value, line.active])).toEqual([
    ["legacy", false],
    ["n1", true],
  ]);
});

test("other workspaces have no legacy entry, and lines without voice are left out", () => {
  const lines = callerLines({
    workspaceId: OTHER,
    ironWingId: IRON,
    legacyPhone: "+18178653016",
    connections: [
      {
        numbers: [
          number("a", "+12025550100"),
          number("b", "+12025550101", { voice_enabled: false }),
        ],
      },
      { numbers: [number("c", "+12025550102")] },
    ],
  });
  expect(plain(lines).map((line) => line.value)).toEqual(["a", "c"]);
  expect(plain(lines).some((line) => line.active)).toBe(false);
});

test("without a legacy number configured, Iron Wing lists only its lines", () => {
  expect(
    plain(
      callerLines({
        workspaceId: IRON,
        ironWingId: IRON,
        legacyPhone: "",
        connections: [],
      }),
    ),
  ).toEqual([]);
});
