const fs = require("fs");
const vm = require("vm");
const path = require("path");
const source = fs
  .readFileSync(path.join(__dirname, "../frontend/src/callMessage.mjs"), "utf8")
  .replace("export function", "function");
const messageTargetForCall = vm.runInNewContext(
  `${source}\nmessageTargetForCall`,
);

test("uses the call's sending number rather than the active number", () => {
  expect(
    messageTargetForCall("+1 (817) 653-0282", "+18178653016", "+15550000001"),
  ).toEqual({ phone: "+18176530282", localNumber: "+18178653016" });
});
test("falls back to the active number when the call has no local number", () => {
  expect(messageTargetForCall("+18176530282", null, "+15550000001")).toEqual({
    phone: "+18176530282",
    localNumber: "+15550000001",
  });
});
test("does not open an invalid recipient or an unspecified sender", () => {
  expect(
    messageTargetForCall("client:operator", "+15550000001", ""),
  ).toBeNull();
  expect(messageTargetForCall("+18176530282", "", "")).toBeNull();
});
