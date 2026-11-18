const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const sender = require("../../src/outreachIntake/sender");
const { getConfig, isReady } = require("../../src/outreachIntake/config");

const fixture = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../../docs/contracts/fixtures/jack.call.v1.json"),
    "utf8",
  ),
);
const config = {
  enabled: true,
  url: "https://outreach.example.test/internal/sales/intake/jack",
  token: "test-token",
  signingSecret: "test-signing-secret",
  workspaceId: "00000000-0000-4000-8000-000000000001",
  sourceBaseUrl: null,
};
const NOW = 1763478245000; // fixed clock

// A fake db: the claim returns `rows`; later updates are recorded.
function fakeDb(rows) {
  const updates = [];
  return {
    updates,
    query: jest.fn(async (sql, params) => {
      if (/FOR UPDATE SKIP LOCKED/.test(sql)) return { rows };
      updates.push({ sql, params });
      return { rowCount: 1 };
    }),
  };
}
const pending = (overrides = {}) => ({
  id: "1",
  event_id: fixture.event_id,
  payload: fixture,
  attempts: 0,
  ...overrides,
});
const respondWith = (status) =>
  jest.fn(async () => ({ status, body: { cancel: jest.fn() } }));

describe("config", () => {
  const full = {
    OUTREACH_INTAKE_ENABLED: "1",
    OUTREACH_INTAKE_URL: "https://outreach.example.test/x",
    OUTREACH_INTAKE_TOKEN: "t",
    OUTREACH_INTAKE_SIGNING_SECRET: "s",
    OUTREACH_INTAKE_WORKSPACE_ID: "00000000-0000-4000-8000-000000000001",
  };
  test("is ready only when switched on with url, token, secret and workspace", () => {
    expect(isReady(getConfig(full))).toBe(true);
    expect(isReady(getConfig({}))).toBe(false);
    expect(
      isReady(getConfig({ ...full, OUTREACH_INTAKE_ENABLED: "true" })),
    ).toBe(false);
    for (const key of [
      "OUTREACH_INTAKE_URL",
      "OUTREACH_INTAKE_TOKEN",
      "OUTREACH_INTAKE_SIGNING_SECRET",
      "OUTREACH_INTAKE_WORKSPACE_ID",
    ])
      expect(isReady(getConfig({ ...full, [key]: "" }))).toBe(false);
    expect(
      isReady(getConfig({ ...full, OUTREACH_INTAKE_WORKSPACE_ID: "ws-1" })),
    ).toBe(false);
    expect(
      isReady(getConfig({ ...full, OUTREACH_INTAKE_URL: "not a url" })),
    ).toBe(false);
  });

  test("the source link base is the app's public origin", () => {
    expect(
      getConfig({ TWILIO_WEBHOOK_BASE_URL: "https://twilio.example.test/" })
        .sourceBaseUrl,
    ).toBe("https://twilio.example.test");
    expect(getConfig({}).sourceBaseUrl).toBeFalsy();
  });
});

describe("start", () => {
  test("does not start when disabled", () => {
    const every = jest.fn();
    expect(
      sender.start({
        config: { ...config, enabled: false },
        setInterval: every,
      }),
    ).toBeNull();
    expect(
      sender.start({ config: { ...config, token: null }, setInterval: every }),
    ).toBeNull();
    expect(every).not.toHaveBeenCalled();
  });

  test("starts an unref'd 30-second loop with one run in flight", async () => {
    const unref = jest.fn();
    let tick;
    const every = jest.fn((fn) => {
      tick = fn;
      return { unref };
    });
    let release;
    const db = {
      query: jest.fn(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ rows: [] });
          }),
      ),
    };
    sender.start({ config, setInterval: every, db, fetch: jest.fn() });
    expect(every).toHaveBeenCalledWith(expect.any(Function), 30000);
    expect(unref).toHaveBeenCalled();
    const first = tick();
    await tick(); // skipped: the first run is still going
    expect(db.query).toHaveBeenCalledTimes(1);
    release();
    await first;
    const second = tick();
    expect(db.query).toHaveBeenCalledTimes(2);
    release();
    await second;
  });
});

describe("runOnce", () => {
  test("posts the signed body and marks it delivered", async () => {
    const db = fakeDb([pending()]);
    const fetch = respondWith(202);
    const counts = await sender.runOnce({ db, fetch, config, now: () => NOW });
    expect(counts).toEqual({ delivered: 1, retry: 0, failed: 0 });

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(config.url);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers.Authorization).toBe("Bearer test-token");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual(fixture);

    // The receiver can verify the signature by recomputing it.
    const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(
      init.headers["X-IW-Signature"],
    );
    expect(match).not.toBeNull();
    expect(Number(match[1])).toBe(Math.floor(NOW / 1000));
    const expected = crypto
      .createHmac("sha256", config.signingSecret)
      .update(`${match[1]}.${init.body}`)
      .digest("hex");
    expect(match[2]).toBe(expected);

    expect(db.updates[0].sql).toMatch(/status = 'DELIVERED'/);
    expect(db.updates[0].params).toEqual(["1", 1]);
  });

  test("claims with FOR UPDATE SKIP LOCKED and only PENDING due rows", async () => {
    const db = fakeDb([]);
    await sender.runOnce({ db, fetch: jest.fn(), config });
    const [sql] = db.query.mock.calls[0];
    expect(sql).toMatch(/status = 'PENDING' AND next_attempt_at <= now\(\)/);
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
  });

  test("does nothing when not configured", async () => {
    const db = fakeDb([pending()]);
    const fetch = jest.fn();
    await sender.runOnce({ db, fetch, config: { ...config, enabled: false } });
    expect(db.query).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([400, 401, 403, 404, 409, 422])("a %i is final", async (status) => {
    const db = fakeDb([pending()]);
    const counts = await sender.runOnce({
      db,
      fetch: respondWith(status),
      config,
    });
    expect(counts.failed).toBe(1);
    expect(db.updates[0].sql).toMatch(/status = 'FAILED'/);
    expect(db.updates[0].params).toEqual(["1", 1, `HTTP_${status}`]);
  });

  test.each([408, 429, 500, 502, 503])(
    "a %i is retried after a backoff",
    async (status) => {
      const db = fakeDb([pending({ attempts: 1 })]);
      const counts = await sender.runOnce({
        db,
        fetch: respondWith(status),
        config,
      });
      expect(counts.retry).toBe(1);
      expect(db.updates[0].sql).toMatch(/next_attempt_at = now\(\) \+/);
      expect(db.updates[0].params).toEqual(["1", 2, `HTTP_${status}`, 300]);
    },
  );

  test("a timeout and a network error are retried with safe codes", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const network = new TypeError("fetch failed: secret-host");
    const db = fakeDb([pending({ id: "1" }), pending({ id: "2" })]);
    const fetch = jest
      .fn()
      .mockRejectedValueOnce(abort)
      .mockRejectedValueOnce(network);
    const counts = await sender.runOnce({ db, fetch, config });
    expect(counts.retry).toBe(2);
    expect(db.updates.map((u) => u.params[2])).toEqual(["TIMEOUT", "NETWORK"]);
    expect(JSON.stringify(db.updates)).not.toContain("secret");
  });

  test("the twelfth failed attempt is final", async () => {
    const db = fakeDb([pending({ attempts: 11 })]);
    await sender.runOnce({ db, fetch: respondWith(503), config });
    expect(db.updates[0].sql).toMatch(/status = 'FAILED'/);
    expect(db.updates[0].params).toEqual(["1", 12, "HTTP_503"]);
  });

  test("a payload that breaks the contract is not sent", async () => {
    const bad = { ...fixture, call: { ...fixture.call, transcript: [] } };
    const db = fakeDb([pending({ payload: bad })]);
    const fetch = jest.fn();
    await sender.runOnce({ db, fetch, config });
    expect(fetch).not.toHaveBeenCalled();
    expect(db.updates[0].params).toEqual(["1", 1, "INVALID_PAYLOAD"]);
  });

  test("rows are sent oldest first", async () => {
    const db = fakeDb([pending({ id: "9" }), pending({ id: "3" })]);
    await sender.runOnce({ db, fetch: respondWith(200), config });
    expect(db.updates.map((u) => u.params[0])).toEqual(["3", "9"]);
  });
});

describe("classification and backoff", () => {
  test("backoff is 1m, 5m, 30m, 2h, then 6h", () => {
    expect([1, 2, 3, 4, 5, 6, 11].map(sender.backoffSeconds)).toEqual([
      60, 300, 1800, 7200, 21600, 21600, 21600,
    ]);
  });

  test("classify", () => {
    expect(sender.classify({ status: 204 }).result).toBe("delivered");
    expect(sender.classify({ status: 418 })).toEqual({
      result: "failed",
      code: "HTTP_418",
    });
    expect(sender.classify({ status: 429 }).result).toBe("retry");
    expect(sender.classify({ error: new TypeError("x") }).code).toBe("NETWORK");
  });

  test("sign uses t + '.' + body", () => {
    const sig = sender.sign("k", '{"a":1}', 100);
    expect(sig).toBe(
      `t=100,v1=${crypto.createHmac("sha256", "k").update('100.{"a":1}').digest("hex")}`,
    );
  });
});
