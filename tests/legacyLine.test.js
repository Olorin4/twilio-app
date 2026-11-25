jest.mock("../src/db", () => ({ query: jest.fn() }));
const pool = require("../src/db");
const { IRON_WING_WORKSPACE_ID } = require("../src/workspaceContext");
const { movedLegacyNumbers, legacyMoved } = require("../src/legacyLine");

const saved = {};
beforeEach(() => {
  jest.clearAllMocks();
  for (const key of ["TWILIO_CALLER_ID", "TWILIO_PREVIOUS_NUMBERS"])
    saved[key] = process.env[key];
  process.env.TWILIO_CALLER_ID = "+18178653016";
  process.env.TWILIO_PREVIOUS_NUMBERS = "+15550001111";
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});

test("a legacy number in an Iron Wing connection is moved", async () => {
  pool.query.mockResolvedValue({ rows: [{ phone_number: "+18178653016" }] });
  expect(await movedLegacyNumbers()).toEqual(["+18178653016"]);
  expect(await legacyMoved()).toBe(true);
  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toContain("connection_numbers");
  expect(params).toEqual([
    IRON_WING_WORKSPACE_ID,
    ["+18178653016", "+15550001111"],
  ]);
});

test("a previous number not in a connection is not moved", async () => {
  pool.query.mockResolvedValue({ rows: [{ phone_number: "+18178653016" }] });
  expect(await movedLegacyNumbers()).not.toContain("+15550001111");
});

test("the main number is not moved while only a previous number is", async () => {
  pool.query.mockResolvedValue({ rows: [{ phone_number: "+15550001111" }] });
  expect(await legacyMoved()).toBe(false);
});

test("nothing is moved when no legacy number is configured", async () => {
  delete process.env.TWILIO_CALLER_ID;
  delete process.env.TWILIO_PREVIOUS_NUMBERS;
  expect(await movedLegacyNumbers()).toEqual([]);
  expect(await legacyMoved()).toBe(false);
  expect(pool.query).not.toHaveBeenCalled();
});

test("a database passed in is used instead of the pool", async () => {
  const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
  expect(await movedLegacyNumbers(db)).toEqual([]);
  expect(db.query).toHaveBeenCalled();
  expect(pool.query).not.toHaveBeenCalled();
});
