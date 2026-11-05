jest.mock("../src/db", () => ({ query: jest.fn() }));
jest.mock("../src/token", () => ({ client: {} }));
jest.mock("../src/callEvents", () => ({ saveLeg: jest.fn() }));
jest.mock("../src/conversations", () => ({ saveStatus: jest.fn() }));
jest.mock("../src/messageEvents", () => ({ publish: jest.fn() }));
const pool = require("../src/db");
const { syncStream } = require("../src/reconciliation");
beforeEach(() => jest.clearAllMocks());
test("processes every page and advances checkpoint only after successful processing", async () => {
  pool.query
    .mockResolvedValueOnce({
      rows: [{ synced_through: new Date("2026-01-02T12:00:00Z") }],
    })
    .mockResolvedValueOnce({});
  const second = {
    instances: [{ id: 2 }],
    nextPage: jest.fn().mockResolvedValue(undefined),
  };
  const first = {
    instances: [{ id: 1 }],
    nextPage: jest.fn().mockResolvedValue(second),
  };
  const api = { page: jest.fn().mockResolvedValue(first) };
  const save = jest.fn().mockResolvedValue(undefined);
  expect(await syncStream("calls", api, save)).toBe(2);
  expect(api.page).toHaveBeenCalledWith({
    startTimeAfter: new Date("2026-01-01T12:00:00Z"),
    pageSize: 100,
  });
  expect(save.mock.calls).toEqual([[{ id: 1 }], [{ id: 2 }]]);
  expect(pool.query.mock.calls[1][0]).toContain(
    "UPDATE twilio_sync_checkpoints",
  );
});
test("a failed later page does not advance the checkpoint", async () => {
  pool.query.mockResolvedValueOnce({ rows: [{ synced_through: new Date() }] });
  const api = {
    page: jest
      .fn()
      .mockResolvedValue({
        instances: [],
        nextPage: jest.fn().mockRejectedValue(new Error("Twilio unavailable")),
      }),
  };
  await expect(syncStream("messages", api, jest.fn())).rejects.toThrow(
    "Twilio unavailable",
  );
  expect(pool.query).toHaveBeenCalledTimes(1);
});
