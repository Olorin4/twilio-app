jest.mock("../src/token", () => ({
  callerId: "+15550001111",
  client: { messages: { create: jest.fn() } },
}));
jest.mock("../src/db", () => ({ query: jest.fn() }));
const { client } = require("../src/token");
const pool = require("../src/db");
const { sendSms } = require("../src/sendSms");

function request(body, contentType = "application/json") {
  const req = { body, is: (type) => type === contentType };
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return { req, res };
}
beforeEach(() => jest.resetAllMocks());

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
