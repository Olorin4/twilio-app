jest.mock("../src/workspaceConnections", () => ({
  updateNumberSettings: jest.fn(),
}));
jest.mock("../src/agentProfiles", () => ({
  listProfiles: jest.fn(),
  createProfile: jest.fn(),
  updateProfile: jest.fn(),
  setDefault: jest.fn(),
  listRevisions: jest.fn(),
  restoreRevision: jest.fn(),
}));
jest.mock("../src/twilioConnectionValidation", () => ({}));
const router = require("../src/workspaceSettings");
const { requireSettingsWrite } = router;
const profiles = require("../src/agentProfiles");
const connections = require("../src/workspaceConnections");
const originalBase = process.env.TWILIO_WEBHOOK_BASE_URL;
const originalOrigin = process.env.APP_ORIGIN;
const response = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn(),
});
beforeEach(() => {
  process.env.TWILIO_WEBHOOK_BASE_URL = "https://example.com";
  delete process.env.APP_ORIGIN;
});
afterAll(() => {
  if (originalBase === undefined) delete process.env.TWILIO_WEBHOOK_BASE_URL;
  else process.env.TWILIO_WEBHOOK_BASE_URL = originalBase;
  if (originalOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = originalOrigin;
});
test("accepts same-origin JSON settings writes", () => {
  const next = jest.fn();
  requireSettingsWrite(
    { is: () => true, get: () => "https://example.com" },
    response(),
    next,
  );
  expect(next).toHaveBeenCalled();
});
test("rejects untrusted or absent origins and non-JSON requests", () => {
  for (const origin of [undefined, "https://attacker.example"]) {
    const res = response(),
      next = jest.fn();
    requireSettingsWrite({ is: () => true, get: () => origin }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  }
  const res = response();
  requireSettingsWrite({ is: () => false }, res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(415);
});

// The last handler on a route is the real one; earlier layers are guards.
function handlerFor(method, path) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method} ${path} route`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
const WS = "00000000-0000-0000-0000-000000000001";
const ROUTES = [
  ["get", "/workspaces/:workspaceId/agents", profiles.listProfiles, {}],
  ["post", "/workspaces/:workspaceId/agents", profiles.createProfile, {}],
  [
    "put",
    "/workspaces/:workspaceId/agents/:agentId",
    profiles.updateProfile,
    { agentId: "a" },
  ],
  [
    "post",
    "/workspaces/:workspaceId/agents/:agentId/default",
    profiles.setDefault,
    { agentId: "a" },
  ],
  [
    "get",
    "/workspaces/:workspaceId/agents/:agentId/revisions",
    profiles.listRevisions,
    { agentId: "a" },
  ],
  [
    "post",
    "/workspaces/:workspaceId/agents/:agentId/revisions/:revisionId/restore",
    profiles.restoreRevision,
    { agentId: "a", revisionId: "1" },
  ],
  [
    "patch",
    "/workspaces/:workspaceId/numbers/:numberId",
    connections.updateNumberSettings,
    { numberId: "n" },
  ],
];
test.each(ROUTES)(
  "agent and number routes map validation errors to 400: %s %s",
  async (method, path, store, extra) => {
    const handler = handlerFor(method, path);
    const known = [
      "Enter valid agent settings: name is required.",
      "Agent does not exist.",
      "Revision does not exist.",
      "Choose an agent from this workspace.",
      "Enter a line label of up to 60 characters.",
      "Enter valid number settings.",
    ];
    for (const message of known) {
      store.mockRejectedValueOnce(new Error(message));
      const res = response();
      await handler({ params: { workspaceId: WS, ...extra }, body: {} }, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: message });
    }
    jest.spyOn(console, "error").mockImplementation(() => {});
    store.mockRejectedValueOnce(new Error("connection refused 10.0.0.1"));
    const res = response();
    await handler({ params: { workspaceId: WS, ...extra }, body: {} }, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: "Could not update workspace settings.",
    });
    console.error.mockRestore();
  },
);
test("agent writes pass savedBy operator and number settings pass the body", async () => {
  profiles.createProfile.mockResolvedValueOnce({ id: "a" });
  let res = response();
  await handlerFor("post", "/workspaces/:workspaceId/agents")(
    { params: { workspaceId: WS }, body: { name: "x", kind: "support" } },
    res,
  );
  expect(profiles.createProfile).toHaveBeenCalledWith(
    WS,
    { name: "x", kind: "support" },
    "operator",
  );
  expect(res.status).toHaveBeenCalledWith(201);
  connections.updateNumberSettings.mockResolvedValueOnce({ id: "n" });
  res = response();
  await handlerFor("patch", "/workspaces/:workspaceId/numbers/:numberId")(
    {
      params: { workspaceId: WS, numberId: "n" },
      body: { handler: "ai_agent", agentProfileId: "a", label: "Sales" },
    },
    res,
  );
  expect(connections.updateNumberSettings).toHaveBeenCalledWith(WS, "n", {
    handler: "ai_agent",
    agentProfileId: "a",
    label: "Sales",
    observeHours: undefined,
  });
});
