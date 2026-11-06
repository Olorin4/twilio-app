jest.mock("../src/db", () => ({ query: jest.fn() }));
jest.mock("../src/messageEvents", () => ({ publish: jest.fn() }));
const pool = require("../src/db");
const { publish } = require("../src/messageEvents");
const { callback } = require("../src/callEvents");
const body = {
  CallSid: "CA" + "1".repeat(32),
  ParentCallSid: "CA" + "2".repeat(32),
  CallStatus: "no-answer",
};
beforeEach(() => jest.clearAllMocks());
test("valid call callback persists its parent and announces the update", async () => {
  const res = { sendStatus: jest.fn() };
  await callback({ body }, res);
  expect(pool.query).toHaveBeenCalledWith(
    expect.stringContaining("twilio_call_legs.answered OR EXCLUDED.answered"),
    [
      body.CallSid,
      body.ParentCallSid,
      "no-answer",
      5,
      false,
      null,
      "00000000-0000-4000-8000-000000000001",
      null,
    ],
  );
  expect(publish).toHaveBeenCalledTimes(1);
  expect(res.sendStatus).toHaveBeenCalledWith(204);
});
test("invalid callbacks are rejected without a write", async () => {
  const res = { sendStatus: jest.fn() };
  await callback({ body: { ...body, CallStatus: "unknown" } }, res);
  expect(res.sendStatus).toHaveBeenCalledWith(400);
  expect(pool.query).not.toHaveBeenCalled();
});
test("storage errors return a failure for Twilio", async () => {
  pool.query.mockRejectedValueOnce(new Error("database unavailable"));
  const res = { sendStatus: jest.fn() };
  await callback({ body }, res);
  expect(res.sendStatus).toHaveBeenCalledWith(500);
  expect(publish).not.toHaveBeenCalled();
});
