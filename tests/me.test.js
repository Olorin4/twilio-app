jest.mock("../src/db", () => ({ query: jest.fn(), connect: jest.fn() }));
const router = require("../src/router");

function handler() {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === "/me" && l.route.methods.get,
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
const response = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

test("GET /me returns the signed-in user without a workspace", () => {
  const res = response();
  handler()(
    {
      user: {
        id: "11111111-1111-4111-8111-111111111111",
        username: "dana",
        displayName: "Dana",
        role: "member",
        enabled: true,
        bootstrap: false,
        workspaceIds: ["x"],
      },
    },
    res,
  );
  expect(res.json).toHaveBeenCalledWith({
    id: "11111111-1111-4111-8111-111111111111",
    username: "dana",
    displayName: "Dana",
    role: "member",
    bootstrap: false,
  });
  const boot = response();
  handler()(
    {
      user: {
        id: null,
        username: "operator",
        displayName: "Operator",
        role: "owner",
        bootstrap: true,
        workspaceIds: [],
      },
    },
    boot,
  );
  expect(boot.json).toHaveBeenCalledWith({
    id: null,
    username: "operator",
    displayName: "Operator",
    role: "owner",
    bootstrap: true,
  });
});

test("GET /me is not behind resolveWorkspace and needs a user", () => {
  const layer = router.stack.find((l) => l.route && l.route.path === "/me");
  expect(layer.route.stack).toHaveLength(1);
  const res = response();
  handler()({}, res);
  expect(res.status).toHaveBeenCalledWith(401);
});

describe("GET /me/lines", () => {
  const pool = require("../src/db");
  const IRON_WING = "00000000-0000-4000-8000-000000000001";
  const OTHER = "00000000-0000-4000-8000-000000000002";
  const CONNECTION = "00000000-0000-4000-8000-0000000000b1";
  const owner = {
    id: "00000000-0000-4000-8000-0000000000b2",
    role: "owner",
    bootstrap: false,
    workspaceIds: [],
  };
  const member = {
    id: "00000000-0000-4000-8000-0000000000b3",
    role: "member",
    bootstrap: false,
    workspaceIds: [IRON_WING],
  };
  const row = (n, label) => ({
    number_id: `00000000-0000-4000-8000-00000000000${n}`,
    phone_number: `+1202555010${n}`,
    label,
    connection_id: CONNECTION,
  });
  const line = (n, label) => ({
    numberId: `00000000-0000-4000-8000-00000000000${n}`,
    phoneNumber: `+1202555010${n}`,
    label,
    legacy: false,
    connectionId: CONNECTION,
  });
  const linesHandler = () => {
    const layer = router.stack.find(
      (l) => l.route && l.route.path === "/me/lines" && l.route.methods.get,
    );
    return layer.route.stack[layer.route.stack.length - 1].handle;
  };
  const ask = async (user, workspace) => {
    const res = response();
    await linesHandler()({ user, query: { workspace } }, res);
    return res;
  };
  let previous;
  beforeEach(() => {
    previous = process.env.TWILIO_CALLER_ID;
    process.env.TWILIO_CALLER_ID = "+15550000001";
    pool.query.mockReset();
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.TWILIO_CALLER_ID;
    else process.env.TWILIO_CALLER_ID = previous;
  });

  test("an owner gets every voice line of the workspace, plus legacy in Iron Wing", async () => {
    pool.query.mockResolvedValue({ rows: [row(1, "Main"), row(2, null)] });
    const res = await ask(owner, IRON_WING);
    expect(res.json).toHaveBeenCalledWith([
      line(1, "Main"),
      line(2, null),
      {
        numberId: null,
        phoneNumber: "+15550000001",
        label: null,
        legacy: true,
        connectionId: null,
      },
    ]);
    expect(pool.query.mock.calls[0][1]).toEqual([IRON_WING]);
    // No legacy line outside Iron Wing.
    const other = await ask(owner, OTHER);
    expect(other.json).toHaveBeenCalledWith([line(1, "Main"), line(2, null)]);
  });

  test("the bootstrap owner gets the same lines", async () => {
    pool.query.mockResolvedValue({ rows: [row(1, "Main")] });
    const res = await ask(
      { id: null, role: "owner", bootstrap: true, workspaceIds: [] },
      IRON_WING,
    );
    expect(res.json.mock.calls[0][0]).toHaveLength(2);
  });

  test("a member gets only their assigned voice lines and never legacy", async () => {
    pool.query.mockResolvedValue({ rows: [row(3, "Desk")] });
    const res = await ask(member, IRON_WING);
    expect(res.json).toHaveBeenCalledWith([line(3, "Desk")]);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/number_assignees/);
    expect(params).toEqual([member.id, IRON_WING, true]);
  });

  test("a workspace the user can't open is not found", async () => {
    const res = await ask(member, OTHER);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: "Workspace not found." });
    expect(pool.query).not.toHaveBeenCalled();
    const bad = await ask(owner, "not-a-workspace");
    expect(bad.status).toHaveBeenCalledWith(400);
    const nobody = await ask(undefined, IRON_WING);
    expect(nobody.status).toHaveBeenCalledWith(401);
  });

  test("a database failure is a 503", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    pool.query.mockRejectedValue(new Error("down"));
    const res = await ask(owner, IRON_WING);
    expect(res.status).toHaveBeenCalledWith(503);
    console.error.mockRestore();
  });
});
