jest.mock("../src/db", () => ({ query: jest.fn() }));
const pool = require("../src/db");
const {
  resolveWorkspace,
  canOpenWorkspace,
  IRON_WING_WORKSPACE_ID,
} = require("../src/workspaceContext");
const response = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn(),
});
const OTHER = "00000000-0000-4000-8000-000000000002";
const owner = { id: "o1", role: "owner", workspaceIds: [] };
const bootstrap = {
  id: null,
  username: "operator",
  role: "owner",
  bootstrap: true,
  workspaceIds: [],
};
const member = { id: "m1", role: "member", workspaceIds: [OTHER] };
const ironMember = {
  id: "m2",
  role: "member",
  workspaceIds: [IRON_WING_WORKSPACE_ID],
};
const req = (user, header) => ({ user, get: () => header });
beforeEach(() => jest.clearAllMocks());
test("defaults to the existing Iron Wing workspace", async () => {
  for (const user of [owner, bootstrap, ironMember]) {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: IRON_WING_WORKSPACE_ID, name: "Iron Wing" }],
    });
    const r = req(user, undefined),
      next = jest.fn();
    await resolveWorkspace(r, response(), next);
    expect(pool.query).toHaveBeenLastCalledWith(expect.any(String), [
      IRON_WING_WORKSPACE_ID,
    ]);
    expect(r.workspace.id).toBe(IRON_WING_WORKSPACE_ID);
    expect(next).toHaveBeenCalled();
  }
});
test("rejects malformed and unknown workspaces rather than defaulting to Iron Wing", async () => {
  let res = response(),
    next = jest.fn();
  await resolveWorkspace(req(owner, "invalid"), res, next);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(pool.query).not.toHaveBeenCalled();
  pool.query.mockResolvedValueOnce({ rows: [] });
  res = response();
  await resolveWorkspace(
    req(owner, "00000000-0000-4000-8000-000000000099"),
    res,
    next,
  );
  expect(res.status).toHaveBeenCalledWith(404);
  expect(next).not.toHaveBeenCalled();
});
test("only active workspaces resolve", async () => {
  pool.query.mockResolvedValueOnce({ rows: [] });
  const res = response();
  await resolveWorkspace(req(owner, OTHER), res, jest.fn());
  expect(pool.query.mock.calls[0][0]).toContain("archived_at IS NULL");
  expect(res.status).toHaveBeenCalledWith(404);
});

test("canOpenWorkspace: owners open every workspace, members only their own", () => {
  expect(canOpenWorkspace(owner, OTHER)).toBe(true);
  expect(canOpenWorkspace(bootstrap, IRON_WING_WORKSPACE_ID)).toBe(true);
  expect(canOpenWorkspace(member, OTHER)).toBe(true);
  expect(canOpenWorkspace(member, OTHER.toUpperCase())).toBe(true);
  expect(canOpenWorkspace(member, IRON_WING_WORKSPACE_ID)).toBe(false);
  expect(canOpenWorkspace(undefined, OTHER)).toBe(false);
  expect(canOpenWorkspace(null, OTHER)).toBe(false);
  expect(canOpenWorkspace({ role: "member" }, OTHER)).toBe(false);
  expect(
    canOpenWorkspace({ role: "admin", workspaceIds: [OTHER] }, OTHER),
  ).toBe(false);
});

test("members cannot open other workspaces", async () => {
  // A forged X-Workspace-Id for a workspace the member isn't in gets the same
  // 404 as an unknown one, without touching the database.
  let res = response(),
    next = jest.fn();
  await resolveWorkspace(req(member, IRON_WING_WORKSPACE_ID), res, next);
  expect(res.status).toHaveBeenCalledWith(404);
  expect(res.json).toHaveBeenCalledWith({ error: "Workspace not found." });
  expect(next).not.toHaveBeenCalled();
  expect(pool.query).not.toHaveBeenCalled();

  // An absent header is not a silent fallback to Iron Wing for that member.
  res = response();
  await resolveWorkspace(req(member, undefined), res, next);
  expect(res.status).toHaveBeenCalledWith(404);
  expect(next).not.toHaveBeenCalled();
  expect(pool.query).not.toHaveBeenCalled();

  // Their own workspace resolves.
  pool.query.mockResolvedValueOnce({ rows: [{ id: OTHER, name: "Other" }] });
  const own = req(member, OTHER);
  await resolveWorkspace(own, response(), next);
  expect(own.workspace.id).toBe(OTHER);
  expect(next).toHaveBeenCalledTimes(1);

  // An owner passes for the same forged header.
  pool.query.mockResolvedValueOnce({
    rows: [{ id: IRON_WING_WORKSPACE_ID, name: "Iron Wing" }],
  });
  const asOwner = req(owner, IRON_WING_WORKSPACE_ID);
  await resolveWorkspace(asOwner, response(), next);
  expect(asOwner.workspace.id).toBe(IRON_WING_WORKSPACE_ID);
  expect(next).toHaveBeenCalledTimes(2);
});

test("a request without a signed-in user never resolves a workspace", async () => {
  const res = response(),
    next = jest.fn();
  await resolveWorkspace(req(undefined, OTHER), res, next);
  expect(res.status).toHaveBeenCalledWith(404);
  expect(next).not.toHaveBeenCalled();
  expect(pool.query).not.toHaveBeenCalled();
});
