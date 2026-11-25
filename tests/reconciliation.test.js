jest.mock("../src/db", () => ({ query: jest.fn() }));
jest.mock("../src/token", () => ({
  client: {},
  getIdentity: () => "operator",
}));
jest.mock("../src/callEvents", () => ({ saveLeg: jest.fn() }));
jest.mock("../src/conversations", () => ({
  saveStatus: jest.fn(),
  numbers: jest.fn(() => []),
}));
jest.mock("../src/legacyLine", () => ({
  movedLegacyNumbers: jest.fn(async () => []),
}));
jest.mock("../src/messageEvents", () => ({ publish: jest.fn() }));
const pool = require("../src/db");
const {
  syncStream,
  reconcileWorkspace,
  reconcileAll,
  saveCall,
  refreshPrices,
  reconcileOne,
  handleRequest,
} = require("../src/reconciliation");
beforeEach(() => jest.clearAllMocks());
test("processes every page and advances checkpoint only after successful processing", async () => {
  pool.query
    .mockResolvedValueOnce({
      rows: [{ synced_through: new Date("2026-01-02T12:00:00Z") }],
    })
    .mockResolvedValueOnce({});
  const second = {
    instances: [{ id: 2 }],
    nextPage: jest.fn().mockResolvedValue(undefined),
  };
  const first = {
    instances: [{ id: 1 }],
    nextPage: jest.fn().mockResolvedValue(second),
  };
  const api = { page: jest.fn().mockResolvedValue(first) };
  const save = jest.fn().mockResolvedValue(undefined);
  expect(await syncStream("calls", api, save)).toBe(2);
  expect(api.page).toHaveBeenCalledWith({
    startTimeAfter: new Date("2026-01-01T12:00:00Z"),
    pageSize: 100,
  });
  expect(save.mock.calls).toEqual([[{ id: 1 }], [{ id: 2 }]]);
  expect(pool.query.mock.calls[1][0]).toContain(
    "UPDATE twilio_sync_checkpoints",
  );
});
test("a failed later page does not advance the checkpoint", async () => {
  pool.query.mockResolvedValueOnce({ rows: [{ synced_through: new Date() }] });
  const api = {
    page: jest.fn().mockResolvedValue({
      instances: [],
      nextPage: jest.fn().mockRejectedValue(new Error("Twilio unavailable")),
    }),
  };
  await expect(syncStream("messages", api, jest.fn())).rejects.toThrow(
    "Twilio unavailable",
  );
  expect(pool.query).toHaveBeenCalledTimes(1);
});
test("a workspace without connections is skipped instead of failing", async () => {
  pool.query.mockResolvedValueOnce({ rows: [] });
  await expect(
    reconcileWorkspace("00000000-0000-4000-8000-000000000002"),
  ).resolves.toBe(0);
});
test("an empty workspace does not make the scheduled run fail", async () => {
  pool.query
    .mockResolvedValueOnce({
      rows: [{ id: "00000000-0000-4000-8000-000000000002" }],
    })
    .mockResolvedValueOnce({ rows: [] });
  await expect(reconcileAll()).resolves.toBeUndefined();
});

describe("call prices from Twilio", () => {
  const call = (overrides = {}) => ({
    sid: "CA1",
    startTime: new Date("2026-11-16T12:02:07Z"),
    from: "+15551230009",
    to: "+15551234567",
    status: "completed",
    duration: "93",
    direction: "inbound",
    price: "-0.01700",
    priceUnit: "USD",
    ...overrides,
  });

  test("the price Twilio reports is stored as a positive amount with its currency", async () => {
    pool.query.mockResolvedValue({ rowCount: 1 });
    await saveCall(call());
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(
      /price = COALESCE\(EXCLUDED\.price, call_logs\.price\)/,
    );
    expect(params.slice(-2)).toEqual([0.017, "USD"]);
  });

  test("a call Twilio has not priced yet keeps whatever is stored", async () => {
    pool.query.mockResolvedValue({ rowCount: 1 });
    await saveCall(call({ price: null }));
    expect(pool.query.mock.calls[0][1].slice(-2)).toEqual([null, null]);
  });

  test("older calls still without a price are looked up again in one listing", async () => {
    const owner = {
      workspaceId: "00000000-0000-4000-8000-000000000001",
      id: null,
      client: { calls: { page: jest.fn() } },
    };
    pool.query
      .mockResolvedValueOnce({
        rows: [
          { call_sid: "CA1", timestamp: new Date("2026-11-10T09:00:00Z") },
          { call_sid: "CA2", timestamp: new Date("2026-11-12T09:00:00Z") },
        ],
      })
      .mockResolvedValue({ rowCount: 1 });
    owner.client.calls.page.mockResolvedValue({
      instances: [
        call({ sid: "CA1", price: "-0.00850" }),
        call({ sid: "CA2", price: null }),
        call({ sid: "CA9", price: "-0.5" }),
      ],
      nextPage: jest.fn().mockResolvedValue(undefined),
    });
    expect(await refreshPrices(owner, new Date("2026-11-16T12:00:00Z"))).toBe(
      1,
    );
    expect(owner.client.calls.page).toHaveBeenCalledWith({
      startTimeAfter: new Date("2026-11-09T09:00:00Z"),
      pageSize: 100,
    });
    const updates = pool.query.mock.calls.slice(1);
    expect(updates).toHaveLength(1);
    expect(updates[0][0]).toMatch(/UPDATE call_logs SET price = \$2/);
    expect(updates[0][1].slice(0, 3)).toEqual(["CA1", 0.0085, "USD"]);
  });

  test("nothing is asked of Twilio when every recent call has a price", async () => {
    const owner = {
      workspaceId: "00000000-0000-4000-8000-000000000001",
      id: null,
      client: { calls: { page: jest.fn() } },
    };
    pool.query.mockResolvedValueOnce({ rows: [] });
    expect(await refreshPrices(owner, new Date())).toBe(0);
    expect(owner.client.calls.page).not.toHaveBeenCalled();
  });
});

describe("softphone identities in the sync", () => {
  const connectionId = "cccccccc-3333-4333-8333-333333333333";
  const userHex = "aaaaaaaa111141118111111111111111";
  const stream = (instances) => ({
    page: jest.fn().mockResolvedValue({
      instances,
      nextPage: jest.fn().mockResolvedValue(undefined),
    }),
  });
  async function sync(owner, calls) {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes("synced_through FROM"))
        return { rows: [{ synced_through: new Date() }] };
      return { rows: [], rowCount: 1 };
    });
    await reconcileOne({
      ...owner,
      client: { calls: stream(calls), messages: stream([]) },
    });
    return pool.query.mock.calls
      .filter(([sql]) => sql.includes("INSERT INTO call_logs"))
      .map(([, params]) => params[0]);
  }
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  test("saves a root call placed by a user identity on its connection", async () => {
    const saved = await sync({ workspaceId, id: connectionId }, [
      {
        sid: "CA1",
        direction: "outbound-api",
        from: `client:u${userHex}_c${connectionId.replace(/-/g, "")}`,
        to: "+15550000009",
      },
      {
        sid: "CA2",
        direction: "outbound-api",
        from: `client:u${userHex}_cdddddddd444444448444444444444444`,
        to: "+15550000009",
      },
    ]);
    expect(saved).toEqual(["CA1"]);
  });
  test("saves a legacy root call placed by a user's legacy identity", async () => {
    const saved = await sync({ workspaceId, id: null }, [
      {
        sid: "CA3",
        direction: "outbound-api",
        from: `client:u${userHex}_legacy`,
        to: "+15550000009",
      },
      {
        sid: "CA4",
        direction: "outbound-api",
        from: "client:operator",
        to: "+15550000009",
      },
      {
        sid: "CA5",
        direction: "outbound-api",
        from: `client:connection_${connectionId.replace(/-/g, "")}`,
        to: "+15550000009",
      },
    ]);
    expect(saved).toEqual(["CA3", "CA4"]);
  });
});

describe("the legacy sync and a moved main number", () => {
  const MAIN = "+18178653016";
  const conversations = require("../src/conversations");
  const { movedLegacyNumbers } = require("../src/legacyLine");
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const inbound = [
    { sid: "CA6", direction: "inbound", from: "+15550000009", to: MAIN },
  ];
  const stream = (instances) => ({
    page: jest.fn().mockResolvedValue({
      instances,
      nextPage: jest.fn().mockResolvedValue(undefined),
    }),
  });
  async function legacySync() {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes("synced_through FROM"))
        return { rows: [{ synced_through: new Date() }] };
      return { rows: [], rowCount: 1 };
    });
    await reconcileOne({
      workspaceId,
      id: null,
      client: { calls: stream(inbound), messages: stream([]) },
    });
    return pool.query.mock.calls
      .filter(([sql]) => sql.includes("INSERT INTO call_logs"))
      .map(([, params]) => params[0]);
  }
  beforeEach(() => conversations.numbers.mockReturnValue([MAIN]));
  afterEach(() => {
    conversations.numbers.mockReturnValue([]);
    movedLegacyNumbers.mockResolvedValue([]);
  });

  test("the legacy sync does not own a moved number", async () => {
    movedLegacyNumbers.mockResolvedValue([MAIN]);
    expect(await legacySync()).toEqual([]);
  });

  test("after release the legacy sync owns it again", async () => {
    movedLegacyNumbers.mockResolvedValue([]);
    expect(await legacySync()).toEqual(["CA6"]);
  });

  test("the connection sync does not re-attribute a call the /voice webhook logged", async () => {
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await saveCall(inbound[0], {
      workspaceId,
      id: "64d9ad54-3d96-4d4b-a227-e1bc7870784a",
    });
    const [sql, params] = pool.query.mock.calls.find(([text]) =>
      text.includes("INSERT INTO call_logs"),
    );
    // The upsert only updates a row already owned by the same connection, so a
    // NULL-connection row from /voice keeps its owner.
    expect(sql).toContain(
      "WHERE call_logs.workspace_id = EXCLUDED.workspace_id AND call_logs.provider_connection_id IS NOT DISTINCT FROM EXCLUDED.provider_connection_id",
    );
    expect(params[8]).toBe("64d9ad54-3d96-4d4b-a227-e1bc7870784a");
  });
});

test("a failed sync request is a 503, which Cloudflare passes through", async () => {
  pool.query.mockRejectedValue(new Error("connect ETIMEDOUT"));
  const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
  await handleRequest(
    { workspace: { id: "00000000-0000-4000-8000-000000000002" } },
    res,
  );
  expect(res.status).toHaveBeenCalledWith(503);
});
