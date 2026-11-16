const {
  parseDocket,
  speakDigits,
  lookupCarrier,
} = require("../../src/receptionist/carrierLookup");

const row = {
  dot_number: "295923",
  legal_name: "H FRED BAREFOOT TRUCKING INC",
  phy_city: "ALUM BANK",
  phy_state: "PA",
  power_units: "23",
  total_drivers: "20",
  status_code: "A",
  add_date: "19870618",
  docket1prefix: "MC",
  docket1: "196057",
};
const ok = (rows) =>
  jest.fn().mockResolvedValue({ ok: true, json: async () => rows });
const q = { kind: "mc", digits: "196057" };

test.each([
  ["MC 0123-4567", { kind: "mc", digits: "1234567" }],
  ["196057", { kind: "mc", digits: "196057" }],
  ["m c one", { kind: null, digits: null }],
  ["US DOT 295917", { kind: "usdot", digits: "295917" }],
  ["dot number 000295917", { kind: "usdot", digits: "295917" }],
  ["123456789", { kind: null, digits: null }],
  ["0000", { kind: null, digits: null }],
  ["", { kind: null, digits: null }],
  [undefined, { kind: null, digits: null }],
])("parseDocket(%s)", (input, out) => expect(parseDocket(input)).toEqual(out));

test("speakDigits separates digits so they are read one by one", () => {
  expect(speakDigits("1234567")).toBe("1 2 3 4 5 6 7");
});

test("a match maps the census row", async () => {
  const fetchImpl = ok([row]);
  const r = await lookupCarrier(q, { fetchImpl });
  expect(r).toEqual({
    found: true,
    usdot: "295923",
    mc: "196057",
    legalName: "H FRED BAREFOOT TRUCKING INC",
    dbaName: null,
    city: "ALUM BANK",
    state: "PA",
    powerUnits: 23,
    drivers: 20,
    usdotActive: true,
    since: 1987,
  });
  const url = new URL(fetchImpl.mock.calls[0][0]);
  expect(url.origin + url.pathname).toBe(
    "https://data.transportation.gov/resource/az4n-8mr2.json",
  );
  expect(url.searchParams.get("$where")).toBe(
    "(docket1prefix='MC' AND docket1='196057') OR (docket2prefix='MC' AND docket2='196057') OR (docket3prefix='MC' AND docket3='196057')",
  );
  expect(url.searchParams.get("$limit")).toBe("2");
});

test("a USDOT lookup queries by DOT number and reports the carrier's MC", async () => {
  const fetchImpl = ok([
    { ...row, docket1prefix: "FF", docket2prefix: "MC", docket2: "555" },
  ]);
  const r = await lookupCarrier(
    { kind: "usdot", digits: "295923" },
    { fetchImpl },
  );
  expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get("$where")).toBe(
    "dot_number='295923'",
  );
  expect(r).toMatchObject({ found: true, usdot: "295923", mc: "555" });
});

test("a carrier with no MC docket and sparse fields still maps cleanly", async () => {
  const r = await lookupCarrier(
    { kind: "usdot", digits: "1" },
    {
      fetchImpl: ok([
        { dot_number: "1", legal_name: "SOLO LLC", status_code: "I" },
      ]),
    },
  );
  expect(r).toEqual({
    found: true,
    usdot: "1",
    mc: null,
    legalName: "SOLO LLC",
    dbaName: null,
    city: null,
    state: null,
    powerUnits: null,
    drivers: null,
    usdotActive: false,
    since: null,
  });
});

test("only digits ever reach the query", async () => {
  const fetchImpl = ok([row]);
  expect(
    await lookupCarrier({ kind: "mc", digits: "1' OR '1'='1" }, { fetchImpl }),
  ).toEqual({ found: false, reason: "error" });
  expect(
    await lookupCarrier({ kind: "ff", digits: "196057" }, { fetchImpl }),
  ).toEqual({
    found: false,
    reason: "error",
  });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("empty result, HTTP error, bad JSON, network error and timeout never throw", async () => {
  expect(await lookupCarrier(q, { fetchImpl: ok([]) })).toEqual({
    found: false,
    reason: "no_match",
  });
  expect(
    await lookupCarrier(q, {
      fetchImpl: async () => ({ ok: false, status: 500 }),
    }),
  ).toEqual({ found: false, reason: "error" });
  expect(
    await lookupCarrier(q, {
      fetchImpl: async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError("bad json");
        },
      }),
    }),
  ).toEqual({ found: false, reason: "error" });
  expect(
    await lookupCarrier(q, {
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    }),
  ).toEqual({ found: false, reason: "error" });
  const hanging = (url, { signal }) =>
    new Promise((resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason)),
    );
  expect(await lookupCarrier(q, { fetchImpl: hanging, timeoutMs: 20 })).toEqual(
    {
      found: false,
      reason: "timeout",
    },
  );
});

test("a fetch that ignores the abort signal still times out", async () => {
  expect(
    await lookupCarrier(q, {
      fetchImpl: () => new Promise(() => {}),
      timeoutMs: 20,
    }),
  ).toEqual({ found: false, reason: "timeout" });
});
