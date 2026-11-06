jest.mock("../src/db", () => ({ query: jest.fn() }));
const pool = require("../src/db");
const {
  resolveWorkspace,
  IRON_WING_WORKSPACE_ID,
} = require("../src/workspaceContext");
const response = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn(),
});
beforeEach(() => jest.clearAllMocks());
test("defaults to the existing Iron Wing workspace", async () => {
  pool.query.mockResolvedValueOnce({
    rows: [{ id: IRON_WING_WORKSPACE_ID, name: "Iron Wing" }],
  });
  const req = { get: () => undefined },
    next = jest.fn();
  await resolveWorkspace(req, response(), next);
  expect(pool.query).toHaveBeenCalledWith(expect.any(String), [
    IRON_WING_WORKSPACE_ID,
  ]);
  expect(req.workspace.id).toBe(IRON_WING_WORKSPACE_ID);
  expect(next).toHaveBeenCalled();
});
test("rejects malformed and unknown workspaces rather than defaulting to Iron Wing", async () => {
  let res = response(),
    next = jest.fn();
  await resolveWorkspace({ get: () => "invalid" }, res, next);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(pool.query).not.toHaveBeenCalled();
  pool.query.mockResolvedValueOnce({ rows: [] });
  res = response();
  await resolveWorkspace(
    { get: () => "00000000-0000-4000-8000-000000000099" },
    res,
    next,
  );
  expect(res.status).toHaveBeenCalledWith(404);
  expect(next).not.toHaveBeenCalled();
});
