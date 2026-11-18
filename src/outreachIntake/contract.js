/* The jack.call.v1 event this app sends to Outreach when Jack takes a lead.
It mirrors the schema Outreach owns; docs/contracts/fixtures/jack.call.v1.json
is shared by both sides and checked by the tests. Objects are strict so that
nothing beyond the contract (a transcript, a script, costs) can slip in.
Amendment agreed with Outreach: call.outcome may be "not_a_lead" on a later
revision, when the summary found that a call reported as a lead was not one. */

const { z } = require("zod");

const CONTRACT = "jack.call.v1";
const SUMMARY_MAX = 2000;
// Outreach's column limits; the payload builder cuts values to fit.
const LIMITS = Object.freeze({
  caller_name: 200,
  company: 200,
  mc_number: 32,
  usdot: 32,
  callback_promise: 500,
  fleet_size: 100,
  summary: SUMMARY_MAX,
});

const phone = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/)
  .nullable();
const text = (max) => z.string().max(max).nullable();
const isoTime = z.iso.datetime();

const jackCallV1 = z
  .strictObject({
    contract: z.literal(CONTRACT),
    event_id: z.uuid(),
    occurred_at: isoTime,
    record: z.strictObject({
      id: z.string().min(1),
      revision: z.number().int().positive(),
    }),
    call: z.strictObject({
      started_at: isoTime,
      ended_at: isoTime.nullable(),
      outcome: z.enum(["lead", "not_a_lead"]),
      from_number: phone,
      callback_number: phone,
      caller_name: text(LIMITS.caller_name),
      company: text(LIMITS.company),
      mc_number: text(LIMITS.mc_number),
      usdot: text(LIMITS.usdot),
      mc_verified: z.boolean(),
      interest: z.enum(["high", "medium", "low", "unknown"]),
      callback_promise: text(LIMITS.callback_promise),
      fleet_size: text(LIMITS.fleet_size),
      summary: text(LIMITS.summary),
      summary_status: z.enum(["PENDING", "READY", "UNAVAILABLE"]),
    }),
    source_link: z.url().nullable(),
  })
  // not_a_lead only retracts a call already reported as a lead, so it can
  // never be the first revision.
  .refine(
    (event) => event.call.outcome === "lead" || event.record.revision > 1,
    {
      message: "not_a_lead is valid only for revision 2 or later",
      path: ["call", "outcome"],
    },
  );

module.exports = { CONTRACT, SUMMARY_MAX, LIMITS, jackCallV1 };
