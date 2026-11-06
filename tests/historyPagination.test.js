jest.mock("twilio", () => jest.fn(() => ({ calls: {}, messages: {} })));
jest.mock("../src/token", () => ({ accountSid: "ACtest", authToken: "test" }));
jest.mock("../src/db", () => ({ query: jest.fn() }));
const pool = require("../src/db");
const { getCallLogs, getMessageLogs } = require("../src/logManager");

beforeEach(() => jest.clearAllMocks());

test.each([getCallLogs, getMessageLogs])(
  "paginates history and indicates a following page",
  async (handler) => {
    pool.query.mockResolvedValue({
      rows: Array.from({ length: 11 }, (_, id) => ({ id })),
    });
    const res = {
      set: jest.fn(),
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };
    await handler({ query: { page: "2", search: " Alex " } }, res);
    expect(pool.query.mock.calls[0][1]).toEqual([
      process.env.TWILIO_CALLER_ID,
      "alex",
      10,
      11,
      "00000000-0000-4000-8000-000000000001",
    ]);
    expect(res.set).toHaveBeenCalledWith("X-Has-More", "true");
    expect(res.json.mock.calls[0][0]).toHaveLength(10);
  },
);

test.each([getCallLogs, getMessageLogs])(
  "rejects invalid page numbers",
  async (handler) => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await handler({ query: { page: "-1" } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(pool.query).not.toHaveBeenCalled();
  },
);

test.each([getCallLogs, getMessageLogs])(
  "uses selected page size for results and offset",
  async (handler) => {
    pool.query.mockResolvedValue({
      rows: Array.from({ length: 21 }, (_, id) => ({ id })),
    });
    const res = {
      set: jest.fn(),
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };
    await handler({ query: { page: "3", pageSize: "20" } }, res);
    expect(pool.query.mock.calls[0][1]).toEqual([
      process.env.TWILIO_CALLER_ID,
      "",
      40,
      21,
      "00000000-0000-4000-8000-000000000001",
    ]);
    expect(res.set).toHaveBeenCalledWith("X-Has-More", "true");
    expect(res.json.mock.calls[0][0]).toHaveLength(20);
  },
);

test.each([getCallLogs, getMessageLogs])(
  "rejects unsupported page size",
  async (handler) => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await handler({ query: { pageSize: "1000" } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(pool.query).not.toHaveBeenCalled();
  },
);
