jest.mock("../src/db", () => ({ query: jest.fn() }));
jest.mock("../src/workspaceConnections", () => ({
  updateNumberSettings: jest.fn(),
  setNumberAssignees: jest.fn(),
  listWorkspaces: jest.fn(),
  listVoiceTargets: jest.fn(),
}));
jest.mock("../src/assistantSettings", () => ({
  getAssistantSettings: jest.fn(),
  updateAssistantSettings: jest.fn(),
}));
jest.mock("../src/agentProfiles", () => ({
  listProfiles: jest.fn(),
  createProfile: jest.fn(),
  updateProfile: jest.fn(),
  setDefault: jest.fn(),
  listRevisions: jest.fn(),
  restoreRevision: jest.fn(),
}));
jest.mock("../src/users", () => ({
  listUsers: jest.fn(),
  createUser: jest.fn(),
  updateUser: jest.fn(),
  setPassword: jest.fn(),
}));
jest.mock("../src/twilioConnectionValidation", () => ({}));
const router = require("../src/workspaceSettings");
const { requireSettingsWrite } = router;
const profiles = require("../src/agentProfiles");
const connections = require("../src/workspaceConnections");
const users = require("../src/users");
const assistantSettings = require("../src/assistantSettings");
const pool = require("../src/db");
const express = require("express");
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
const OWNER = { id: "o1", username: "olive", role: "owner", workspaceIds: [] };
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
      await handler(
        { user: OWNER, params: { workspaceId: WS, ...extra }, body: {} },
        res,
      );
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: message });
    }
    jest.spyOn(console, "error").mockImplementation(() => {});
    store.mockRejectedValueOnce(new Error("connection refused 10.0.0.1"));
    const res = response();
    await handler(
      { user: OWNER, params: { workspaceId: WS, ...extra }, body: {} },
      res,
    );
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: "Could not update workspace settings.",
    });
    console.error.mockRestore();
  },
);
test("agent writes pass savedBy and number settings pass the body", async () => {
  profiles.createProfile.mockResolvedValueOnce({ id: "a" });
  let res = response();
  await handlerFor("post", "/workspaces/:workspaceId/agents")(
    {
      user: OWNER,
      params: { workspaceId: WS },
      body: { name: "x", kind: "support" },
    },
    res,
  );
  expect(profiles.createProfile).toHaveBeenCalledWith(
    WS,
    { name: "x", kind: "support" },
    "olive",
  );
  expect(res.status).toHaveBeenCalledWith(201);
  connections.updateNumberSettings.mockResolvedValueOnce({ id: "n" });
  res = response();
  await handlerFor("patch", "/workspaces/:workspaceId/numbers/:numberId")(
    {
      user: OWNER,
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
    personal: undefined,
  });
});

test("agent profile saves record the username, or operator for bootstrap", async () => {
  const BOOT = {
    id: null,
    username: "operator",
    role: "owner",
    bootstrap: true,
  };
  const cases = [
    ["post", "/workspaces/:workspaceId/agents", profiles.createProfile, {}, 2],
    [
      "put",
      "/workspaces/:workspaceId/agents/:agentId",
      profiles.updateProfile,
      { agentId: "a" },
      3,
    ],
    [
      "post",
      "/workspaces/:workspaceId/agents/:agentId/revisions/:revisionId/restore",
      profiles.restoreRevision,
      { agentId: "a", revisionId: "1" },
      3,
    ],
  ];
  for (const [method, path, store, extra, index] of cases) {
    for (const [user, expected] of [
      [OWNER, "olive"],
      [BOOT, "operator"],
    ]) {
      store.mockClear();
      store.mockResolvedValueOnce({});
      await handlerFor(method, path)(
        { user, params: { workspaceId: WS, ...extra }, body: {} },
        response(),
      );
      expect(store.mock.calls[0][index]).toBe(expected);
    }
  }
});

test("number settings pass personal through", async () => {
  connections.updateNumberSettings.mockResolvedValueOnce({ id: "n" });
  await handlerFor("patch", "/workspaces/:workspaceId/numbers/:numberId")(
    {
      user: OWNER,
      params: { workspaceId: WS, numberId: "n" },
      body: { personal: true },
    },
    response(),
  );
  expect(connections.updateNumberSettings.mock.calls.at(-1)[2].personal).toBe(
    true,
  );
});

const USER_ROUTES = [
  ["get", "/users", users.listUsers, {}],
  ["post", "/users", users.createUser, {}],
  ["patch", "/users/:userId", users.updateUser, { userId: "u" }],
  ["post", "/users/:userId/password", users.setPassword, { userId: "u" }],
  [
    "put",
    "/workspaces/:workspaceId/numbers/:numberId/assignees",
    connections.setNumberAssignees,
    { numberId: "n" },
  ],
];
test.each(USER_ROUTES)(
  "user routes map store errors to 400 and others to 500: %s %s",
  async (method, path, store, extra) => {
    const handler = handlerFor(method, path);
    const known = [
      "Enter a username of 3 to 40 letters, numbers, dots, dashes or underscores.",
      "Enter a password of 12 to 200 characters.",
      "That username is taken.",
      "User does not exist.",
      "Keep at least one enabled owner.",
      "Choose a role of owner or member.",
      "Enter a display name of 1 to 80 characters.",
      "Choose valid workspaces.",
      "Enabled must be true or false.",
      "Choose people who can open this workspace.",
    ];
    for (const message of known) {
      store.mockRejectedValueOnce(new Error(message));
      const res = response();
      await handler(
        { user: OWNER, params: { workspaceId: WS, ...extra }, body: {} },
        res,
      );
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: message });
    }
    jest.spyOn(console, "error").mockImplementation(() => {});
    store.mockRejectedValueOnce(new Error("connection refused 10.0.0.1"));
    const res = response();
    await handler(
      { user: OWNER, params: { workspaceId: WS, ...extra }, body: {} },
      res,
    );
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: "Could not update workspace settings.",
    });
    console.error.mockRestore();
  },
);

test("user routes pass the right arguments and respond with the right status", async () => {
  const body = {
    username: "dana",
    displayName: "Dana",
    password: "correct horse battery",
    role: "member",
    workspaceIds: [WS],
    extra: "ignored",
  };
  users.createUser.mockResolvedValueOnce({ id: "u", username: "dana" });
  let res = response();
  await handlerFor("post", "/users")({ user: OWNER, params: {}, body }, res);
  expect(users.createUser).toHaveBeenCalledWith({
    username: "dana",
    displayName: "Dana",
    password: "correct horse battery",
    role: "member",
    workspaceIds: [WS],
  });
  expect(res.status).toHaveBeenCalledWith(201);
  expect(JSON.stringify(res.json.mock.calls)).not.toContain("correct horse");

  users.updateUser.mockResolvedValueOnce({ id: "u" });
  await handlerFor("patch", "/users/:userId")(
    {
      user: OWNER,
      params: { userId: "u" },
      body: { enabled: false, password: "sneaky sneaky sneaky" },
    },
    response(),
  );
  expect(users.updateUser).toHaveBeenCalledWith("u", {
    displayName: undefined,
    role: undefined,
    enabled: false,
    workspaceIds: undefined,
  });

  connections.setNumberAssignees.mockResolvedValueOnce({
    numberId: "n",
    userIds: ["u"],
  });
  await handlerFor(
    "put",
    "/workspaces/:workspaceId/numbers/:numberId/assignees",
  )(
    {
      user: OWNER,
      params: { workspaceId: WS, numberId: "n" },
      body: { userIds: ["u"] },
    },
    response(),
  );
  expect(connections.setNumberAssignees).toHaveBeenCalledWith(WS, "n", ["u"]);
});

test("password routes never echo the password", async () => {
  const password = "correct horse battery";
  users.setPassword.mockResolvedValueOnce();
  const res = { ...response(), end: jest.fn(), sendStatus: jest.fn() };
  res.status = jest.fn().mockReturnValue(res);
  await handlerFor("post", "/users/:userId/password")(
    { user: OWNER, params: { userId: "u" }, body: { password } },
    res,
  );
  expect(users.setPassword).toHaveBeenCalledWith("u", password);
  expect(res.status).toHaveBeenCalledWith(204);
  expect(res.json).not.toHaveBeenCalled();
  users.setPassword.mockRejectedValueOnce(
    new Error("Enter a password of 12 to 200 characters."),
  );
  const bad = response();
  await handlerFor("post", "/users/:userId/password")(
    { user: OWNER, params: { userId: "u" }, body: { password: "short" } },
    bad,
  );
  expect(JSON.stringify(bad.json.mock.calls)).not.toContain("short");
});

// Every /settings route is owner-only except three reads members need.
const MEMBER_READS = ["GET /workspaces", "GET /voice-targets", "GET /assist"];
const MEMBER_WS = "00000000-0000-4000-8000-000000000002";
const MEMBER = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "dana",
  role: "member",
  workspaceIds: [MEMBER_WS],
};
describe("over HTTP", () => {
  let server, base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = req.get("X-Test-Role") === "owner" ? OWNER : MEMBER;
      next();
    });
    app.use("/settings", router);
    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${server.address().port}/settings`;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));
  const routes = router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) =>
      Object.keys(layer.route.methods).map((method) => [
        method.toUpperCase(),
        layer.route.path,
      ]),
    );
  const call = (method, path, role) =>
    fetch(base + path.replace(/:\w+/g, MEMBER_WS), {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: "https://example.com",
        "X-Workspace-Id": MEMBER_WS,
        "X-Test-Role": role,
      },
      body: method === "GET" ? undefined : "{}",
    });

  test("the route table covers settings reads and writes", () => {
    expect(routes.length).toBeGreaterThan(20);
    for (const read of MEMBER_READS)
      expect(routes.map(([m, p]) => `${m} ${p}`)).toContain(read);
  });

  const isMemberRead = ([method, path]) =>
    MEMBER_READS.includes(`${method} ${path}`);
  const mockReads = () => {
    pool.query.mockResolvedValue({ rows: [{ id: MEMBER_WS, name: "Other" }] });
    connections.listWorkspaces.mockResolvedValue([]);
    connections.listVoiceTargets.mockResolvedValue([]);
    assistantSettings.getAssistantSettings.mockResolvedValue({});
  };
  const OWNER_ONLY = { error: "Only an owner can change settings." };

  test.each(routes.filter((r) => !isMemberRead(r)))(
    "members get 403 on settings except the three reads: %s %s",
    async (method, path) => {
      const res = await call(method, path, "member");
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(OWNER_ONLY);
    },
  );

  test.each(routes.filter(isMemberRead))(
    "members may use the read %s %s",
    async (method, path) => {
      mockReads();
      const res = await call(method, path, "member");
      expect(res.status).toBe(200);
    },
  );

  test.each(routes)(
    "owners pass the owner check: %s %s",
    async (method, path) => {
      jest.spyOn(console, "error").mockImplementation(() => {});
      mockReads();
      const res = await call(method, path, "owner");
      const body = await res.json().catch(() => null);
      expect(body).not.toEqual(OWNER_ONLY);
      console.error.mockRestore();
    },
  );

  test("member reads are scoped to the signed-in user", async () => {
    connections.listWorkspaces.mockResolvedValue([{ id: MEMBER_WS }]);
    connections.listVoiceTargets.mockResolvedValue([]);
    await call("GET", "/workspaces", "member");
    await call("GET", "/voice-targets", "member");
    expect(connections.listWorkspaces).toHaveBeenLastCalledWith(MEMBER);
    expect(connections.listVoiceTargets).toHaveBeenLastCalledWith(MEMBER);
  });

  test("owner-only applies to method variants and unknown paths too", async () => {
    for (const [method, path] of [
      ["HEAD", "/connections"],
      ["GET", "/nope"],
      ["POST", "/assist"],
    ]) {
      const res = await fetch(base + path, {
        method,
        headers: { "X-Test-Role": "member" },
      });
      expect(res.status).toBe(403);
    }
  });
});
