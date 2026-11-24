/* GET /token mints a softphone token only for req.user's own identity, and the
legacy line only for owners. Uses the real token.js with synthetic credentials;
nothing leaves the process. */
Object.assign(process.env, {
  TWILIO_ACCOUNT_SID: "AC" + "0".repeat(32),
  TWILIO_AUTH_TOKEN: "synthetic",
  TWILIO_TWIML_APP_SID: "AP" + "0".repeat(32),
  TWILIO_API_KEY: "SK" + "0".repeat(32),
  TWILIO_API_SECRET: "synthetic-secret",
  TWILIO_CALLER_ID: "+15550000001",
  TWILIO_IDENTITY: "operator",
});
jest.mock("../src/db", () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock("../src/providerContext", () => ({
  ...jest.requireActual("../src/providerContext"),
  getProvider: jest.fn(),
}));
const { getProvider } = require("../src/providerContext");
const pool = require("../src/db");
const router = require("../src/router");

const IRON_WING = "00000000-0000-4000-8000-000000000001";
const connectionId = "cccccccc-3333-4333-8333-333333333333";
const hexC = connectionId.replace(/-/g, "");
const memberA = {
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  username: "alice",
  displayName: "Alice",
  role: "member",
  enabled: true,
  bootstrap: false,
  workspaceIds: [IRON_WING],
};
const ownerB = {
  id: "bbbbbbbb-2222-4222-8222-222222222222",
  username: "bob",
  displayName: "Bob",
  role: "owner",
  enabled: true,
  bootstrap: false,
  workspaceIds: [],
};
const bootstrap = {
  id: null,
  username: "operator",
  displayName: "Operator",
  role: "owner",
  bootstrap: true,
  workspaceIds: [],
};
const connectionProvider = {
  id: connectionId,
  workspaceId: IRON_WING,
  accountSid: "AC" + "1".repeat(32),
  apiKeySid: "SK" + "1".repeat(32),
  apiKeySecret: "connection-secret",
  twimlAppSid: "AP" + "1".repeat(32),
  numberId: "99999999-9999-4999-8999-999999999999",
  phoneNumber: "+15550000002",
  voiceEnabled: true,
};
const legacyFallback = () =>
  jest.requireActual("../src/providerContext").legacyProvider(IRON_WING);

function handler() {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === "/token" && l.route.methods.get,
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
async function call(user, headers = {}) {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  await handler()(
    {
      user,
      workspace: { id: IRON_WING, name: "Iron Wing" },
      get: (name) => lower[name.toLowerCase()],
      query: { identity: "operator" },
    },
    res,
  );
  return {
    status: res.status.mock.calls[0]?.[0] ?? 200,
    body: res.json.mock.calls[0]?.[0],
  };
}
const jwtIdentity = (token) =>
  JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).grants
    .identity;

beforeAll(() => jest.spyOn(console, "log").mockImplementation(() => {}));
afterAll(() => jest.restoreAllMocks());
// The member's account as the line check reads it: assigned to every line.
const assignedEverywhere = () =>
  pool.query.mockImplementation(async (sql) =>
    /FROM app_users u WHERE u.id/.test(sql)
      ? {
          rows: [
            { role: "member", enabled: true, assigned: true, member: true },
          ],
        }
      : { rows: [] },
  );
beforeEach(() => {
  getProvider.mockReset();
  getProvider.mockResolvedValue(connectionProvider);
  pool.query.mockReset();
  assignedEverywhere();
});

test("a token is only ever for the requesting user", async () => {
  const expected = `u${memberA.id.replace(/-/g, "")}_c${hexC}`;
  for (const headers of [
    {},
    { "X-Identity": "operator" },
    { "X-Identity": `u${ownerB.id.replace(/-/g, "")}_c${hexC}` },
    { "X-Connection-Number-Id": "eeeeeeee-5555-4555-8555-555555555555" },
    { "X-User-Id": ownerB.id },
  ]) {
    const { status, body } = await call(memberA, headers);
    expect(status).toBe(200);
    expect(body.identity).toBe(expected);
    expect(jwtIdentity(body.token)).toBe(expected);
    expect(body.connectionId).toBe(connectionId);
  }
});

test("the bootstrap login keeps today's connection identity", async () => {
  const { status, body } = await call(bootstrap);
  expect(status).toBe(200);
  expect(body.identity).toBe(`connection_${hexC}`);
  expect(jwtIdentity(body.token)).toBe(`connection_${hexC}`);
});

test("an owner on the legacy line gets their own legacy identity", async () => {
  const { status, body } = await call(ownerB, {
    "X-Legacy-Connection": "true",
  });
  expect(status).toBe(200);
  const expected = `u${ownerB.id.replace(/-/g, "")}_legacy`;
  expect(body.identity).toBe(expected);
  expect(jwtIdentity(body.token)).toBe(expected);
  expect(body.connectionId).toBeNull();
});

test("the bootstrap owner on the legacy line keeps getIdentity()", async () => {
  getProvider.mockImplementation(async () => legacyFallback());
  const { status, body } = await call(bootstrap);
  expect(status).toBe(200);
  expect(body.identity).toBe("operator");
  expect(jwtIdentity(body.token)).toBe("operator");
});

test("a member asking for the legacy line by header gets 403 and no token", async () => {
  const { status, body } = await call(memberA, {
    "X-Legacy-Connection": "true",
  });
  expect(status).toBe(403);
  expect(body).toEqual({ error: "Only an owner can use this line." });
});

test("a member whose workspace falls back to the legacy line gets 403 and no token", async () => {
  getProvider.mockImplementation(async () => legacyFallback());
  const { status, body } = await call(memberA);
  expect(status).toBe(403);
  expect(body).toEqual({ error: "Only an owner can use this line." });
});

describe("a member's token uses only a line they may use", () => {
  const OWN = "dddddddd-4444-4444-8444-444444444444";
  const PERSONAL = "eeeeeeee-5555-4555-8555-555555555555";
  const phones = { [OWN]: "+15550000004", [PERSONAL]: "+15550000005" };
  beforeEach(() => {
    getProvider.mockImplementation(async (workspaceId, numberId) => ({
      ...connectionProvider,
      numberId: numberId || PERSONAL, // the active number is someone's personal line
      phoneNumber: phones[numberId || PERSONAL],
    }));
  });
  // ownLines: the member's assigned voice lines, as usableLines reads them.
  const serve = (ownLines) =>
    pool.query.mockImplementation(async (sql, params) => {
      if (/FROM app_users u WHERE u.id/.test(sql))
        return {
          rows: [
            {
              role: "member",
              enabled: true,
              assigned: ownLines.some((line) => line.number_id === params[1]),
              member: true,
            },
          ],
        };
      if (/FROM number_assignees na/.test(sql)) return { rows: ownLines };
      return { rows: [] };
    });
  const own = {
    number_id: OWN,
    phone_number: phones[OWN],
    label: null,
    connection_id: connectionId,
  };

  test("their own requested line is used as asked", async () => {
    serve([own]);
    const { status, body } = await call(memberA, {
      "X-Connection-Number-Id": OWN,
    });
    expect(status).toBe(200);
    expect(body.phoneNumber).toBe(phones[OWN]);
  });

  test("another line, or the workspace's active one, falls back to their own first line", async () => {
    serve([own]);
    for (const headers of [{ "X-Connection-Number-Id": PERSONAL }, {}]) {
      const { status, body } = await call(memberA, headers);
      expect(status).toBe(200);
      expect(body.phoneNumber).toBe(phones[OWN]);
      expect(JSON.stringify(body)).not.toContain(phones[PERSONAL]);
    }
    expect(getProvider).toHaveBeenLastCalledWith(IRON_WING, OWN);
  });

  test("a line on another connection is not a fallback", async () => {
    serve([{ ...own, connection_id: "ffffffff-6666-4666-8666-666666666666" }]);
    const { status, body } = await call(memberA, {
      "X-Connection-Number-Id": PERSONAL,
    });
    expect(status).toBe(403);
    expect(body).toEqual({
      error: "No line is assigned to you in this workspace.",
    });
  });

  test("with no line of their own they get 403 and no token", async () => {
    serve([]);
    const { status, body } = await call(memberA, {
      "X-Connection-Number-Id": PERSONAL,
    });
    expect(status).toBe(403);
    expect(body).toEqual({
      error: "No line is assigned to you in this workspace.",
    });
  });

  test("owners are not narrowed", async () => {
    serve([]);
    const { status, body } = await call(ownerB, {
      "X-Connection-Number-Id": PERSONAL,
    });
    expect(status).toBe(200);
    expect(body.phoneNumber).toBe(phones[PERSONAL]);
  });

  test("a line check that can't read the database answers 503", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    pool.query.mockRejectedValue(new Error("connection refused"));
    const { status } = await call(memberA, { "X-Connection-Number-Id": OWN });
    expect(status).toBe(503);
    console.error.mockRestore();
  });
});
