const fs = require("fs");
const path = require("path");
const { jackCallV1, LIMITS } = require("../../src/outreachIntake/contract");
const {
  uuidV5,
  eventId,
  buildPayload,
} = require("../../src/outreachIntake/payload");
const { NO_SUMMARY } = require("../../src/receptionist/noSummary");

const fixture = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../../docs/contracts/fixtures/jack.call.v1.json"),
    "utf8",
  ),
);

const sid = `CA${"2".repeat(32)}`;
const row = (overrides = {}) => ({
  call_sid: sid,
  workspace_id: "00000000-0000-4000-8000-000000000001",
  from_number: "+15551230009",
  started_at: new Date("2026-11-18T14:58:00.000Z"),
  ended_at: new Date("2026-11-18T15:03:40.000Z"),
  outcome: "lead",
  status: "new",
  caller_name: "Mike Alvarez",
  company: "Alvarez Hauling LLC",
  mc_number: "123456",
  usdot: "7654321",
  mc_verified: true,
  callback_number: "+15551230010",
  callback_promise: "in the next few minutes",
  carrier: { found: true, legalName: "Alvarez Hauling LLC" },
  details: { fleetSize: "2 trucks", interest: "high", equipment: "dry van" },
  summary: "Owner-operator with two dry vans wants dispatch.",
  script: { opener: "Hi Mike" },
  transcript: [{ role: "caller", text: "my number is 555 0100" }],
  usage: [{ input_tokens: 10 }],
  claude_cost: "0.01",
  relay_cost: "0.02",
  ...overrides,
});
const options = {
  revision: 2,
  occurredAt: new Date("2026-11-18T15:04:05.000Z"),
  sourceBaseUrl: "https://twilio.example.test/",
};

describe("jack.call.v1 contract", () => {
  test("the shared fixture parses", () => {
    expect(jackCallV1.safeParse(fixture).success).toBe(true);
  });

  test("the builder's output parses", () => {
    const payload = buildPayload(row(), options);
    expect(jackCallV1.parse(payload)).toEqual(payload);
    expect(payload).toMatchObject({
      contract: "jack.call.v1",
      event_id: eventId(sid, 2),
      occurred_at: "2026-11-18T15:04:05.000Z",
      record: { id: sid, revision: 2 },
      source_link: `https://twilio.example.test/leads#${sid}`,
    });
    expect(payload.call).toEqual({
      started_at: "2026-11-18T14:58:00.000Z",
      ended_at: "2026-11-18T15:03:40.000Z",
      outcome: "lead",
      from_number: "+15551230009",
      callback_number: "+15551230010",
      caller_name: "Mike Alvarez",
      company: "Alvarez Hauling LLC",
      mc_number: "123456",
      usdot: "7654321",
      mc_verified: true,
      interest: "high",
      callback_promise: "in the next few minutes",
      fleet_size: "2 trucks",
      summary: "Owner-operator with two dry vans wants dispatch.",
      summary_status: "READY",
    });
  });

  test("carries no transcript, script, usage or costs", () => {
    const text = JSON.stringify(buildPayload(row(), options));
    for (const leak of [
      "transcript",
      "script",
      "usage",
      "cost",
      "555 0100",
      "Hi Mike",
      "equipment",
      "workspace",
    ])
      expect(text).not.toContain(leak);
  });

  test("not_a_lead is valid only after revision 1", () => {
    const rev2 = buildPayload(row({ outcome: "not_a_lead" }), options);
    expect(rev2.call.outcome).toBe("not_a_lead");
    expect(jackCallV1.safeParse(rev2).success).toBe(true);
    const rev1 = buildPayload(row({ outcome: "not_a_lead" }), {
      ...options,
      revision: 1,
    });
    const result = jackCallV1.safeParse(rev1);
    expect(result.success).toBe(false);
    expect(result.error.issues[0].path).toEqual(["call", "outcome"]);
  });

  test("other outcomes are rejected", () => {
    const payload = buildPayload(row(), options);
    payload.call.outcome = "spam";
    expect(jackCallV1.safeParse(payload).success).toBe(false);
  });

  test("the schema rejects extra fields", () => {
    const payload = buildPayload(row(), options);
    payload.call.transcript = [];
    expect(jackCallV1.safeParse(payload).success).toBe(false);
  });
});

describe("buildPayload", () => {
  test.each(["anonymous", "+266696687", "+8656696", "", null, "12345"])(
    "a blocked or anonymous caller ID (%p) sends no from_number",
    (from) => {
      const payload = buildPayload(
        row({ from_number: from, callback_number: "+266696687" }),
        options,
      );
      expect(payload.call.from_number).toBeNull();
      expect(payload.call.callback_number).toBeNull();
      expect(jackCallV1.safeParse(payload).success).toBe(true);
    },
  );

  test("revision 1 has the summary pending", () => {
    const payload = buildPayload(row(), { ...options, revision: 1 });
    expect(payload.record.revision).toBe(1);
    expect(payload.event_id).toBe(eventId(sid, 1));
    expect(payload.call.summary).toBeNull();
    expect(payload.call.summary_status).toBe("PENDING");
  });

  test("NO_SUMMARY is sent as UNAVAILABLE with no summary", () => {
    const payload = buildPayload(row({ summary: NO_SUMMARY }), options);
    expect(payload.call.summary).toBeNull();
    expect(payload.call.summary_status).toBe("UNAVAILABLE");
    expect(jackCallV1.safeParse(payload).success).toBe(true);
  });

  test("the summary is cut to 2000 characters", () => {
    const payload = buildPayload(row({ summary: "x".repeat(2500) }), options);
    expect(payload.call.summary).toHaveLength(2000);
    expect(jackCallV1.safeParse(payload).success).toBe(true);
  });

  test("long text fields are cut to Outreach's limits", () => {
    expect(LIMITS).toEqual({
      caller_name: 200,
      company: 200,
      mc_number: 32,
      usdot: 32,
      callback_promise: 500,
      fleet_size: 100,
      summary: 2000,
    });
    const long = (n) => "a".repeat(n + 50);
    const payload = buildPayload(
      row({
        caller_name: long(200),
        company: long(200),
        mc_number: "9".repeat(80),
        usdot: "8".repeat(80),
        callback_promise: long(500),
        details: { fleetSize: long(100), interest: "high" },
        summary: long(2000),
      }),
      options,
    );
    for (const [field, max] of Object.entries(LIMITS))
      expect(payload.call[field]).toHaveLength(max);
    expect(jackCallV1.safeParse(payload).success).toBe(true);
  });

  test("values at the limit are kept whole, and a cut never splits a surrogate pair", () => {
    const payload = buildPayload(
      row({
        caller_name: "b".repeat(200),
        company: `${"c".repeat(199)}\u{1F69A}tail`,
      }),
      options,
    );
    expect(payload.call.caller_name).toBe("b".repeat(200));
    expect(payload.call.company).toBe("c".repeat(199));
    expect(jackCallV1.safeParse(payload).success).toBe(true);
  });

  test("the schema rejects a value over its limit", () => {
    for (const [field, max] of Object.entries(LIMITS)) {
      const event = structuredClone(fixture);
      event.call[field] = "z".repeat(max + 1);
      expect(jackCallV1.safeParse(event).success).toBe(false);
    }
  });

  test("missing details fall back to unknown interest and no fleet size", () => {
    const payload = buildPayload(row({ details: null }), options);
    expect(payload.call.interest).toBe("unknown");
    expect(payload.call.fleet_size).toBeNull();
  });

  test("no source link without a base URL", () => {
    const payload = buildPayload(row(), { ...options, sourceBaseUrl: null });
    expect(payload.source_link).toBeNull();
    expect(jackCallV1.safeParse(payload).success).toBe(true);
  });
});

describe("event ids", () => {
  test("uuidV5 matches the RFC test vector", () => {
    // uuid v5 of "www.example.com" in the DNS namespace.
    expect(
      uuidV5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"),
    ).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
  });

  test("are deterministic per call and revision", () => {
    expect(eventId(sid, 1)).toBe(eventId(sid, 1));
    expect(eventId(sid, 1)).not.toBe(eventId(sid, 2));
    expect(eventId(sid, 1)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
