jest.mock("twilio", () => jest.fn(() => ({ calls: {}, messages: {} })));
jest.mock("../src/token", () => ({ accountSid: "ACtest", authToken: "test" }));
jest.mock("../src/db", () => ({ query: jest.fn() }));
jest.mock("../src/messageEvents", () => ({ publish: jest.fn() }));

const pool = require("../src/db");
const { publish } = require("../src/messageEvents");
const { logCall } = require("../src/logManager");

beforeEach(() => jest.clearAllMocks());

test.each([
  [1, 1],
  [0, 0],
])(
  "publishes only when a call is inserted (row count %i)",
  async (rows, notifications) => {
    pool.query.mockResolvedValue({ rowCount: rows });
    await logCall({ CallSid: "CA123" });
    expect(publish).toHaveBeenCalledTimes(notifications);
  },
);
