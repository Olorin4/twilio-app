jest.mock("../src/db", () => ({ query: jest.fn() }));
jest.mock("../src/messageEvents", () => ({ publish: jest.fn() }));
jest.mock("../src/conversations", () => ({ numbers: () => ["+15551234567"] }));
const pool = require("../src/db");
const { publish } = require("../src/messageEvents");
const { counts, markCall, markConversation } = require("../src/activityViews");

beforeEach(() => jest.clearAllMocks());
const response = () => ({
  json: jest.fn(),
  sendStatus: jest.fn(),
  status: jest.fn().mockReturnThis(),
});

test("counts return numeric totals for configured lines", async () => {
  pool.query.mockResolvedValueOnce({ rows: [{ calls: "3", messages: "12" }] });
  const res = response();
  await counts({}, res);
  expect(pool.query.mock.calls[0][1]).toEqual([["+15551234567"]]);
  expect(res.json).toHaveBeenCalledWith({ calls: 3, messages: 12 });
});
test("marking a call is idempotent and publishes only a change", async () => {
  pool.query
    .mockResolvedValueOnce({ rowCount: 1 })
    .mockResolvedValueOnce({ rowCount: 0 });
  const res = response();
  await markCall({ params: { id: "42" } }, res);
  await markCall({ params: { id: "42" } }, res);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(res.sendStatus).toHaveBeenCalledWith(204);
});
test("conversation acknowledgement validates and limits its snapshot", async () => {
  const res = response();
  await markConversation({ body: { phone: "bad", throughId: "10" } }, res);
  expect(res.sendStatus).toHaveBeenCalledWith(400);
  expect(pool.query).not.toHaveBeenCalled();
  pool.query.mockResolvedValueOnce({ rowCount: 1 });
  await markConversation(
    { body: { phone: "+15557654321", throughId: "123" } },
    res,
  );
  expect(pool.query.mock.calls[0][1]).toEqual([
    "+15557654321",
    ["+15551234567"],
    "123",
  ]);
  expect(publish).toHaveBeenCalledTimes(1);
});
