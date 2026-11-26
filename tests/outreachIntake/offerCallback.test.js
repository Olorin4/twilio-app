const { buildPayload } = require("../../src/outreachIntake/payload");
const { jackCallV1 } = require("../../src/outreachIntake/contract");
const {
  OFFER,
  enrollmentOpen,
} = require("../../src/receptionist/dispatchOffer");

test("a delayed Jack event retains its first callback time across revisions", () => {
  const received_at = "2026-12-01T05:59:59.999Z";
  const env = {
    IWD_BLACK_FRIDAY_ENABLED: "1",
    IWD_BLACK_FRIDAY_OPENS_AT: "2026-11-27T06:00:00Z",
  };
  expect(enrollmentOpen(new Date(received_at), env)).toBe(true);
  expect(enrollmentOpen(new Date("2026-12-01T06:00:00Z"), env)).toBe(false);
  expect(enrollmentOpen(new Date(received_at), {})).toBe(false);
  const row = {
    call_sid: "CA001",
    started_at: "2026-12-01T05:58:00.000Z",
    ended_at: "2026-12-01T06:00:01.000Z",
    outcome: "lead",
    callback_number: "+18175550100",
    details: {
      offerCallback: { offer: OFFER, received_at, status: "pending_review" },
    },
  };
  for (const revision of [1, 2]) {
    const event = buildPayload(row, {
      revision,
      occurredAt: "2026-12-02T12:00:00.000Z",
    });
    expect(jackCallV1.parse(event).call.offer_callback).toEqual({
      offer: OFFER,
      received_at,
      status: "pending_review",
    });
    expect(buildPayload(row, { revision }).event_id).toBe(event.event_id);
  }
});
