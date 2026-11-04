jest.mock("../src/db", () => ({ query: jest.fn() }));
jest.mock("../src/messageEvents", () => ({ publish: jest.fn() }));
const pool = require("../src/db");
const { publish } = require("../src/messageEvents");
const { saveStatus, statusCallback, thread } = require("../src/conversations");

beforeEach(() => jest.clearAllMocks());
test("status callback records valid Twilio status and notifies clients", async () => {
  const res = { sendStatus: jest.fn() };
  await statusCallback(
    { body: { MessageSid: "SM" + "1".repeat(32), MessageStatus: "delivered" } },
    res,
  );
  expect(pool.query).toHaveBeenCalledWith(
    expect.stringContaining(
      "message_delivery.status_rank < EXCLUDED.status_rank",
    ),
    ["SM" + "1".repeat(32), "delivered", 5, null],
  );
  expect(publish).toHaveBeenCalled();
  expect(res.sendStatus).toHaveBeenCalledWith(204);
});
test("invalid callback status is rejected without database mutation", async () => {
  const res = { sendStatus: jest.fn() };
  await statusCallback(
    {
      body: { MessageSid: "SM" + "1".repeat(32), MessageStatus: "unexpected" },
    },
    res,
  );
  expect(res.sendStatus).toHaveBeenCalledWith(400);
  expect(pool.query).not.toHaveBeenCalled();
});
test("status write errors propagate for Twilio retry", async () => {
  pool.query.mockRejectedValueOnce(new Error("database unavailable"));
  await expect(saveStatus("SM" + "1".repeat(32), "sent")).rejects.toThrow(
    "database unavailable",
  );
  expect(publish).not.toHaveBeenCalled();
});
test("conversation rejects malformed phone or pagination cursor", async () => {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await thread(
    { query: { phone: "+15551234567", before: "not-a-number" } },
    res,
  );
  expect(res.status).toHaveBeenCalledWith(400);
  expect(pool.query).not.toHaveBeenCalled();
});
