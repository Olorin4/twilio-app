jest.mock("../src/token", () => ({
  callerId: "+15550001111",
  client: { messages: { create: jest.fn() } },
}));
jest.mock("../src/db", () => ({ query: jest.fn() }));
jest.mock("../src/providerContext", () => ({ getProvider: jest.fn() }));
jest.mock("../src/ringing", () => ({
  usableLines: jest.fn(),
  mayUseLine: jest.fn(),
}));
const { client } = require("../src/token");
const { getProvider } = require("../src/providerContext");
const pool = require("../src/db");
const { sendSms } = require("../src/sendSms");
const { usableLines, mayUseLine } = require("../src/ringing");

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const OWNER = {
  id: "00000000-0000-4000-8000-0000000000c1",
  role: "owner",
  bootstrap: false,
};
const MEMBER = {
  id: "00000000-0000-4000-8000-0000000000c2",
  role: "member",
  bootstrap: false,
  workspaceIds: [WORKSPACE],
};
function request(body, contentType = "application/json", user = OWNER) {
  const req = {
    body,
    is: (type) => type === contentType,
    user,
    workspace: { id: WORKSPACE },
    get: () => undefined,
  };
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return { req, res };
}
beforeEach(() => {
  jest.resetAllMocks();
  getProvider.mockResolvedValue({
    legacy: true,
    phoneNumber: "+15550001111",
    workspaceId: "00000000-0000-4000-8000-000000000001",
    smsEnabled: true,
    client,
  });
});

test("accepts a valid message and records the Twilio SID", async () => {
  client.messages.create.mockResolvedValue({ sid: "SM123", status: "queued" });
  const { req, res } = request({ to: "+1 (555) 222-3333", body: "Hello" });
  await sendSms(req, res);
  expect(client.messages.create).toHaveBeenCalledWith({
    from: "+15550001111",
    to: "+15552223333",
    body: "Hello",
  });
  expect(pool.query).toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(202);
  expect(res.json).toHaveBeenCalledWith({
    sid: "SM123",
    status: "queued",
    saved: true,
  });
});

test.each([
  { to: "555", body: "Hello" },
  { to: "+15552223333", body: " " },
  { to: "+15552223333", body: "x".repeat(1601) },
])("rejects invalid input without sending", async (body) => {
  const { req, res } = request(body);
  await sendSms(req, res);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(client.messages.create).not.toHaveBeenCalled();
});

// Cloudflare replaces a 502 or 504 from the app with its own HTML page, so a
// failed send must use another status for its JSON error to reach the browser.
test("a message Twilio refuses is a 422 with Twilio's code", async () => {
  client.messages.create.mockRejectedValue(
    Object.assign(new Error("unreachable"), { status: 400, code: 21612 }),
  );
  const { req, res } = request({ to: "+306980221006", body: "Hi" });
  await sendSms(req, res);
  expect(res.status).toHaveBeenCalledWith(422);
  expect(res.json).toHaveBeenCalledWith({
    error: "Twilio rejected the message (error 21612).",
  });
});
test("a send Twilio did not confirm is a 503", async () => {
  client.messages.create.mockRejectedValue(new Error("socket hang up"));
  const { req, res } = request({ to: "+15552223333", body: "Hi" });
  await sendSms(req, res);
  expect(res.status).toHaveBeenCalledWith(503);
  expect(res.json).toHaveBeenCalledWith({
    error:
      "Could not confirm whether Twilio accepted the message. Check Twilio before retrying.",
  });
});
test("reports acceptance even if saving fails, avoiding duplicate sends", async () => {
  client.messages.create.mockResolvedValue({ sid: "SM123", status: "queued" });
  pool.query.mockRejectedValue(new Error("database unavailable"));
  const { req, res } = request({ to: "+15552223333", body: "Hello" });
  await sendSms(req, res);
  expect(res.json).toHaveBeenCalledWith({
    sid: "SM123",
    status: "queued",
    saved: false,
  });
});

test("rejects non-JSON requests", async () => {
  const { req, res } = request({}, "application/x-www-form-urlencoded");
  await sendSms(req, res);
  expect(res.status).toHaveBeenCalledWith(415);
  expect(client.messages.create).not.toHaveBeenCalled();
});

describe("which line a member may text from", () => {
  const ownLine = "00000000-0000-4000-8000-0000000000d1";
  const secondLine = "00000000-0000-4000-8000-0000000000d2";
  const lines = [
    { numberId: ownLine, phoneNumber: "+15550002222", legacy: false },
    { numberId: secondLine, phoneNumber: "+15550003333", legacy: false },
  ];
  const providerFor = (numberId) => ({
    legacy: false,
    id: "00000000-0000-4000-8000-0000000000d9",
    numberId,
    phoneNumber: lines.find((l) => l.numberId === numberId).phoneNumber,
    workspaceId: WORKSPACE,
    smsEnabled: true,
    client,
  });
  beforeEach(() => {
    usableLines.mockResolvedValue(lines);
    mayUseLine.mockResolvedValue(true);
    getProvider.mockImplementation(async (workspace, numberId) =>
      providerFor(numberId),
    );
    client.messages.create.mockResolvedValue({ sid: "SM9", status: "queued" });
    pool.query.mockResolvedValue({ rows: [] });
  });

  test("a member's localNumber must be assigned to them", async () => {
    const { req, res } = request(
      { to: "+15552223333", body: "Hi", localNumber: "+15550009999" },
      "application/json",
      MEMBER,
    );
    // A forged header naming someone else's line changes nothing.
    req.get = (name) =>
      name === "X-Connection-Number-Id" ? secondLine : undefined;
    await sendSms(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "You can't send from this line.",
    });
    expect(client.messages.create).not.toHaveBeenCalled();
    expect(usableLines).toHaveBeenCalledWith(MEMBER, WORKSPACE, {
      voiceOnly: false,
    });

    const sent = request(
      { to: "+15552223333", body: "Hi", localNumber: "+15550003333" },
      "application/json",
      MEMBER,
    );
    await sendSms(sent.req, sent.res);
    expect(getProvider).toHaveBeenLastCalledWith(WORKSPACE, secondLine);
    expect(mayUseLine).toHaveBeenLastCalledWith(
      MEMBER,
      expect.objectContaining({ numberId: secondLine }),
    );
    expect(client.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ from: "+15550003333" }),
    );
    expect(sent.res.status).toHaveBeenCalledWith(202);
  });

  test("a member without localNumber uses their first assigned line", async () => {
    const { req, res } = request(
      { to: "+15552223333", body: "Hi" },
      "application/json",
      MEMBER,
    );
    await sendSms(req, res);
    expect(getProvider).toHaveBeenCalledWith(WORKSPACE, ownLine);
    expect(client.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ from: "+15550002222" }),
    );
    expect(res.status).toHaveBeenCalledWith(202);
  });

  test("a member with no line, or one the check refuses, can't send", async () => {
    usableLines.mockResolvedValue([]);
    let call = request(
      { to: "+15552223333", body: "Hi" },
      "application/json",
      MEMBER,
    );
    await sendSms(call.req, call.res);
    expect(call.res.status).toHaveBeenCalledWith(403);
    usableLines.mockResolvedValue(lines);
    mayUseLine.mockResolvedValue(false);
    call = request(
      { to: "+15552223333", body: "Hi", localNumber: "+15550002222" },
      "application/json",
      MEMBER,
    );
    await sendSms(call.req, call.res);
    expect(call.res.status).toHaveBeenCalledWith(403);
    expect(call.res.json).toHaveBeenCalledWith({
      error: "You can't send from this line.",
    });
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  test("owners unchanged", async () => {
    getProvider.mockResolvedValue({
      legacy: false,
      id: "00000000-0000-4000-8000-0000000000d9",
      numberId: ownLine,
      phoneNumber: "+15550002222",
      workspaceId: WORKSPACE,
      smsEnabled: true,
      client,
    });
    const { req, res } = request({ to: "+15552223333", body: "Hi" });
    req.get = (name) =>
      name === "X-Connection-Number-Id" ? ownLine : undefined;
    await sendSms(req, res);
    expect(getProvider).toHaveBeenCalledWith(WORKSPACE, ownLine);
    expect(usableLines).not.toHaveBeenCalled();
    expect(mayUseLine).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(202);

    // An owner's localNumber still has to match the selected line.
    const other = request({
      to: "+15552223333",
      body: "Hi",
      localNumber: "+15550003333",
    });
    await sendSms(other.req, other.res);
    expect(other.res.status).toHaveBeenCalledWith(409);
  });

  test("a request without a signed-in user sends nothing", async () => {
    const { req, res } = request(
      { to: "+15552223333", body: "Hi" },
      "application/json",
      null,
    );
    await sendSms(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(client.messages.create).not.toHaveBeenCalled();
  });
});
