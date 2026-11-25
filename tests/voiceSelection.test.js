const fs = require("fs");
const vm = require("vm");
const path = require("path");
const source = fs
  .readFileSync(
    path.join(__dirname, "../frontend/src/voiceSelection.mjs"),
    "utf8",
  )
  .replace(/export (function|const)/g, "$1");
const { ownerVoiceKey } = vm.runInNewContext(`${source}\n({ ownerVoiceKey })`);

const IRON = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

test("an active line's connection is used", () => {
  expect(ownerVoiceKey({ id: IRON, active_connection_id: "c1" }, IRON)).toBe(
    "c1",
  );
});
test("an active line without voice is not used", () => {
  expect(
    ownerVoiceKey(
      { id: IRON, active_connection_id: "c1", active_voice_enabled: false },
      IRON,
    ),
  ).toBeNull();
});
test("Iron Wing with no active line uses the legacy phone", () => {
  expect(ownerVoiceKey({ id: IRON, active_connection_id: null }, IRON)).toBe(
    "legacy",
  );
});
test("once the main number is moved, Iron Wing with no active line uses no phone", () => {
  expect(
    ownerVoiceKey(
      { id: IRON, active_connection_id: null, legacy_moved: true },
      IRON,
    ),
  ).toBeNull();
});
test("another workspace with no active line uses no phone", () => {
  expect(
    ownerVoiceKey({ id: OTHER, active_connection_id: null }, IRON),
  ).toBeNull();
  expect(ownerVoiceKey(undefined, IRON)).toBeNull();
});
