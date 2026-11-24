/* bindIntent only claims a session for a softphone caller of the session's
own line; the SQL itself is covered by callAssist.pg.test.js. */
jest.mock("../src/db", () => ({ query: jest.fn() }));
jest.mock("../src/token", () => ({ getIdentity: () => "operator" }));
const pool = require("../src/db");
const { bindIntent } = require("../src/callAssist/store");

const connection = "cccccccc-3333-4333-8333-333333333333";
const hexC = connection.replace(/-/g, "");
const userHex = "aaaaaaaa111141118111111111111111";
const accountSid = "AC" + "a".repeat(32);
const provider = {
  id: connection,
  workspaceId: "00000000-0000-4000-8000-000000000001",
  accountSid,
  phoneNumber: "+12025550100",
};
const body = (From) => ({
  AssistIntent: "eeeeeeee-5555-4555-8555-555555555555",
  CallSid: "CA" + "a".repeat(32),
  AccountSid: accountSid,
  To: "+12025550111",
  From,
});
const bound = () =>
  pool.query.mock.calls.some(([sql]) =>
    sql.includes("UPDATE phone_call_sessions SET call_sid"),
  );

beforeEach(() => {
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

test("Live Assist binds an intent from a user identity on the line's connection", async () => {
  await bindIntent(body(`client:u${userHex}_c${hexC}`), provider);
  expect(bound()).toBe(true);
});
test("Live Assist still binds the bootstrap connection identity", async () => {
  await bindIntent(body(`client:connection_${hexC}`), provider);
  expect(bound()).toBe(true);
});
test("Live Assist binds a user's legacy identity on the legacy line", async () => {
  await bindIntent(body(`client:u${userHex}_legacy`), {
    ...provider,
    id: undefined,
    legacy: true,
  });
  expect(bound()).toBe(true);
});
test("Live Assist ignores a user identity of another connection", async () => {
  await bindIntent(
    body(`client:u${userHex}_cdddddddd444444448444444444444444`),
    provider,
  );
  await bindIntent(body(`client:u${userHex}_legacy`), provider);
  await bindIntent(body("client:alice"), provider);
  expect(bound()).toBe(false);
});
