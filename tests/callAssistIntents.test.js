/* POST /call-assist/intents builds the call's session on the line the caller
will actually dial from, so bindIntent can link it. Members may only name
their own lines; owners keep the workspace's active number by default. */
jest.mock("../src/db", () => ({ query: jest.fn() }));
jest.mock("../src/providerContext", () => ({ getProvider: jest.fn() }));
jest.mock("../src/assistantSettings", () => ({
  getAssistantSettings: jest.fn(),
}));
jest.mock("../src/ringing", () => ({
  usableLines: jest.fn(),
  mayUseLine: jest.fn(),
}));
jest.mock("../src/token", () => ({ getIdentity: () => "operator" }));

const pool = require("../src/db");
const { getProvider } = require("../src/providerContext");
const { getAssistantSettings } = require("../src/assistantSettings");
const { usableLines, mayUseLine } = require("../src/ringing");
const router = require("../src/callAssist/routes");
const { bindIntent } = require("../src/callAssist/store");

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const CONNECTION = "00000000-0000-4000-8000-0000000000a1";
const ACTIVE = "00000000-0000-4000-8000-0000000000a2";
const OWN = "00000000-0000-4000-8000-0000000000a3";
const OTHER = "00000000-0000-4000-8000-0000000000a4";
const ACCOUNT = "AC" + "a".repeat(32);
const phones = {
  [ACTIVE]: "+12025550100",
  [OWN]: "+12025550101",
  [OTHER]: "+12025550102",
};
const owner = { id: "00000000-0000-4000-8000-0000000000b1", role: "owner" };
const member = {
  id: "00000000-0000-4000-8000-0000000000b2",
  role: "member",
  workspaceIds: [WORKSPACE],
};
const destination = "+12025550199";
const provider = (numberId) => ({
  legacy: false,
  id: CONNECTION,
  numberId,
  workspaceId: WORKSPACE,
  accountSid: ACCOUNT,
  phoneNumber: phones[numberId],
  voiceEnabled: true,
});

const handler = () => {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === "/intents" && l.route.methods.post,
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
};
const response = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
  sendStatus: jest.fn(),
});
async function intent(user, body) {
  const res = response();
  await handler()({ user, workspace: { id: WORKSPACE }, body }, res);
  return res;
}
const inserted = () =>
  pool.query.mock.calls.find(([sql]) =>
    /INSERT INTO phone_call_sessions/.test(sql),
  );

beforeEach(() => {
  jest.resetAllMocks();
  process.env.CALL_ASSIST_ENABLED = "true";
  process.env.TWILIO_WEBHOOK_BASE_URL = "https://example.test";
  pool.query.mockResolvedValue({ rows: [] });
  getAssistantSettings.mockResolvedValue({ jack: true, liveAssist: true });
  getProvider.mockImplementation(async (workspace, numberId) =>
    provider(numberId || ACTIVE),
  );
  usableLines.mockResolvedValue([
    { numberId: OWN, phoneNumber: phones[OWN], legacy: false },
  ]);
  mayUseLine.mockResolvedValue(true);
});
afterAll(() => {
  delete process.env.CALL_ASSIST_ENABLED;
  delete process.env.TWILIO_WEBHOOK_BASE_URL;
});

test("a member's intent on their own line stores that line and binds", async () => {
  const res = await intent(member, {
    destination,
    assist: true,
    numberId: OWN,
  });
  expect(res.status).toHaveBeenCalledWith(201);
  expect(getProvider).toHaveBeenCalledWith(WORKSPACE, OWN);
  expect(usableLines).toHaveBeenCalledWith(member, WORKSPACE);
  expect(mayUseLine).toHaveBeenCalledWith(
    member,
    expect.objectContaining({ numberId: OWN }),
  );
  const [, params] = inserted();
  expect(params[2]).toBe(CONNECTION);
  expect(params[4]).toBe(phones[OWN]);
  const { id } = res.json.mock.calls[0][0];

  // The webhook binds on the line the member calls from: the same number.
  pool.query.mockClear();
  await bindIntent(
    {
      AssistIntent: id,
      CallSid: "CA" + "c".repeat(32),
      From: `client:u${member.id.replace(/-/g, "")}_c${CONNECTION.replace(/-/g, "")}`,
      To: destination,
      AccountSid: ACCOUNT,
    },
    provider(OWN),
  );
  const [sql, bind] = pool.query.mock.calls[0];
  expect(sql).toMatch(/UPDATE phone_call_sessions/);
  expect(bind[0]).toBe(id);
  expect(bind[6]).toBe(params[4]);
  expect(bind[3]).toBe(params[2]);
});

test("a member without numberId gets their first line", async () => {
  const res = await intent(member, { destination });
  expect(res.status).toHaveBeenCalledWith(201);
  expect(getProvider).toHaveBeenCalledWith(WORKSPACE, OWN);
  expect(inserted()[1][4]).toBe(phones[OWN]);
});

test("a member's intent naming another line is refused", async () => {
  let res = await intent(member, { destination, numberId: OTHER });
  expect(res.status).toHaveBeenCalledWith(403);
  expect(res.json).toHaveBeenCalledWith({
    error: "You can't call from this line.",
  });
  expect(inserted()).toBeUndefined();

  // No lines at all, or a line the account check refuses.
  usableLines.mockResolvedValue([]);
  res = await intent(member, { destination });
  expect(res.status).toHaveBeenCalledWith(403);
  usableLines.mockResolvedValue([
    { numberId: OWN, phoneNumber: phones[OWN], legacy: false },
  ]);
  mayUseLine.mockResolvedValue(false);
  res = await intent(member, { destination, numberId: OWN });
  expect(res.status).toHaveBeenCalledWith(403);
  expect(inserted()).toBeUndefined();

  // Not a uuid.
  res = await intent(member, { destination, numberId: "nope" });
  expect(res.status).toHaveBeenCalledWith(400);
});

test("owners unchanged", async () => {
  const res = await intent(owner, { destination, assist: true });
  expect(res.status).toHaveBeenCalledWith(201);
  expect(getProvider).toHaveBeenCalledTimes(1);
  expect(getProvider.mock.calls[0]).toEqual([WORKSPACE]);
  expect(usableLines).not.toHaveBeenCalled();
  expect(mayUseLine).not.toHaveBeenCalled();
  expect(inserted()[1][4]).toBe(phones[ACTIVE]);

  // An owner may name a line explicitly.
  await intent(owner, { destination, numberId: OWN });
  expect(getProvider).toHaveBeenLastCalledWith(WORKSPACE, OWN);
});
