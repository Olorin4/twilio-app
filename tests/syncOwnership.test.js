const { ownsMessage, ownsRootCall } = require("../src/syncOwnership");
const lines = ["+15550000001"];
test("messages belong to the addressed inbound or sending outbound line", () => {
  expect(
    ownsMessage(
      { direction: "inbound", from: "+15550000001", to: "+15550000002" },
      lines,
    ),
  ).toBe(false);
  expect(ownsMessage({ direction: "inbound", to: lines[0] }, lines)).toBe(true);
  expect(
    ownsMessage({ direction: "outbound-api", from: lines[0] }, lines),
  ).toBe(true);
  expect(
    ownsMessage(
      { direction: "outbound-api", from: "+15550000002", to: lines[0] },
      lines,
    ),
  ).toBe(false);
});
test("calls use inbound destination, outbound source or connection identity", () => {
  expect(
    ownsRootCall({ direction: "inbound", to: lines[0] }, lines, "connection_x"),
  ).toBe(true);
  expect(
    ownsRootCall(
      { direction: "inbound", from: "client:connection_x", to: "+15550000002" },
      lines,
      "connection_x",
    ),
  ).toBe(true);
  expect(
    ownsRootCall(
      { direction: "outbound-api", from: "client:connection_x" },
      lines,
      "connection_x",
    ),
  ).toBe(true);
  expect(
    ownsRootCall(
      { direction: "outbound-api", from: "client:connection_y", to: lines[0] },
      lines,
      "connection_x",
    ),
  ).toBe(false);
  expect(
    ownsRootCall(
      { parentCallSid: "parent", direction: "outbound-dial", from: lines[0] },
      lines,
      "connection_x",
    ),
  ).toBe(false);
});
