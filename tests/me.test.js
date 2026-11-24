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
