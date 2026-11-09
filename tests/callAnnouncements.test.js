jest.mock("../src/db", () => ({ query: jest.fn() }));
jest.mock("../src/messageEvents", () => ({ publish: jest.fn() }));
const pool = require("../src/db");
const { handle, saveEvent } = require("../src/callAnnouncements");
const sid = `CA${"1".repeat(32)}`;
const id = "00000000-0000-4000-8000-000000000002";
function response() {
  return {
    type: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    sendStatus: jest.fn().mockReturnThis(),
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  process.env.TWILIO_WEBHOOK_BASE_URL = "https://example.test";
  pool.query.mockResolvedValue({ rowCount: 1 });
});
afterAll(() => delete process.env.TWILIO_WEBHOOK_BASE_URL);
test("unanswered call plays the greeting and records an initiated event", async () => {
  const res = response();
  await handle(
    {
      params: { kind: "missed" },
      body: { CallSid: sid, DialCallStatus: "no-answer" },
    },
    res,
  );
  expect(pool.query.mock.calls[0][1]).toEqual([
    sid,
    "00000000-0000-4000-8000-000000000001",
    null,
    "missed",
    false,
  ]);
  expect(res.send.mock.calls[0][0]).toContain("One of our representatives");
  expect(res.send.mock.calls[0][0]).toContain(
    "https://example.test/announcement/missed/complete",
  );
});
test("an answered call does not play or record a missed-call message", async () => {
  const res = response();
  await handle(
    {
      params: { kind: "missed" },
      body: { CallSid: sid, DialCallStatus: "completed" },
    },
    res,
  );
  expect(pool.query).not.toHaveBeenCalled();
  expect(res.send.mock.calls[0][0]).toContain("<Hangup/>");
  expect(res.send.mock.calls[0][0]).not.toContain("<Say>");
});
test("completion is scoped to the connection and remains separate from initiation", async () => {
  const res = response();
  await handle(
    {
      params: { kind: "closed", phase: "complete" },
      body: { CallSid: sid },
      providerConnection: { id, workspaceId: id },
    },
    res,
  );
  expect(pool.query.mock.calls[0][1]).toEqual([sid, id, id, "closed", true]);
  expect(pool.query.mock.calls[0][0]).toContain(
    "provider_connection_id IS NOT DISTINCT FROM",
  );
  expect(res.send.mock.calls[0][0]).toContain("<Hangup/>");
});
test("a tracking failure does not suppress the greeting", async () => {
  pool.query.mockRejectedValueOnce(new Error("unavailable"));
  const res = response();
  await handle({ params: { kind: "closed" }, body: { CallSid: sid } }, res);
  expect(res.send.mock.calls[0][0]).toContain("office is currently closed");
});
test("invalid call IDs cannot be saved", async () => {
  expect(await saveEvent("bad", "missed", false)).toBe(false);
  expect(pool.query).not.toHaveBeenCalled();
});
