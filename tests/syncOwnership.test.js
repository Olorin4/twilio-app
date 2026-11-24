jest.mock("../src/token", () => ({ getIdentity: () => "operator" }));
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
const connection = { id: "cccccccc-3333-4333-8333-333333333333" };
const other = { id: "dddddddd-4444-4444-8444-444444444444" };
const hexC = connection.id.replace(/-/g, "");
const hexOther = other.id.replace(/-/g, "");
const userHex = "aaaaaaaa111141118111111111111111";
test("calls use inbound destination, outbound source or connection identity", () => {
  expect(
    ownsRootCall({ direction: "inbound", to: lines[0] }, lines, connection),
  ).toBe(true);
  expect(
    ownsRootCall(
      {
        direction: "inbound",
        from: `client:connection_${hexC}`,
        to: "+15550000002",
      },
      lines,
      connection,
    ),
  ).toBe(true);
  expect(
    ownsRootCall(
      { direction: "outbound-api", from: `client:connection_${hexC}` },
      lines,
      connection,
    ),
  ).toBe(true);
  expect(
    ownsRootCall(
      {
        direction: "outbound-api",
        from: `client:connection_${hexOther}`,
        to: lines[0],
      },
      lines,
      connection,
    ),
  ).toBe(false);
  expect(
    ownsRootCall(
      { parentCallSid: "parent", direction: "outbound-dial", from: lines[0] },
      lines,
      connection,
    ),
  ).toBe(false);
});
test("a root call placed by a user identity belongs to its connection", () => {
  const call = {
    direction: "inbound",
    from: `client:u${userHex}_c${hexC}`,
    to: "+15550000009",
  };
  expect(ownsRootCall(call, lines, connection)).toBe(true);
  expect(ownsRootCall(call, [], other)).toBe(false);
  expect(
    ownsRootCall({ ...call, from: `client:u${userHex}_legacy` }, [], {
      legacy: true,
    }),
  ).toBe(true);
  expect(
    ownsRootCall({ ...call, from: "client:operator" }, [], { legacy: true }),
  ).toBe(true);
  expect(ownsRootCall(call, [], { legacy: true })).toBe(false);
});
