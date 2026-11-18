/* Builds the jack.call.v1 event for a receptionist_calls row. Only what the
contract lists is copied: never the transcript, script, usage or costs. */

const crypto = require("crypto");
const { CONTRACT, SUMMARY_MAX } = require("./contract");
const { callableNumber } = require("../receptionist/phone");
const { NO_SUMMARY } = require("../receptionist/noSummary");

// Fixed namespace for event ids, so the same call and revision always get
// the same id. Never change it: Outreach deduplicates on event_id.
const EVENT_NAMESPACE = "3b0c7f52-5d0e-4c55-9a7e-6f0a1f8e2d41";
const INTERESTS = ["high", "medium", "low", "unknown"];

// RFC 9562 UUID version 5 (SHA-1, name-based).
function uuidV5(name, namespace = EVENT_NAMESPACE) {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = crypto
    .createHash("sha1")
    .update(Buffer.concat([ns, Buffer.from(String(name), "utf8")]))
    .digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const eventId = (callSid, revision) => uuidV5(`${callSid}:${revision}`);

const iso = (value) => (value == null ? null : new Date(value).toISOString());
const str = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

// Revision 1 is the call as it closed (summary still pending); revision 2
// carries the stored summary, or UNAVAILABLE when the summary failed.
function summaryFields(row, revision) {
  if (revision === 1) return { summary: null, summary_status: "PENDING" };
  const summary = str(row.summary);
  if (!summary || summary === NO_SUMMARY)
    return { summary: null, summary_status: "UNAVAILABLE" };
  return { summary: summary.slice(0, SUMMARY_MAX), summary_status: "READY" };
}

function buildPayload(row, { revision, occurredAt, sourceBaseUrl } = {}) {
  const details = row.details || {};
  const callSid = row.call_sid;
  return {
    contract: CONTRACT,
    event_id: eventId(callSid, revision),
    occurred_at: iso(occurredAt || new Date()),
    record: { id: callSid, revision },
    call: {
      started_at: iso(row.started_at),
      ended_at: iso(row.ended_at),
      outcome: row.outcome === "not_a_lead" ? "not_a_lead" : "lead",
      from_number: callableNumber(row.from_number),
      callback_number: callableNumber(row.callback_number),
      caller_name: str(row.caller_name),
      company: str(row.company),
      mc_number: str(row.mc_number),
      usdot: str(row.usdot),
      mc_verified: Boolean(row.mc_verified),
      interest: INTERESTS.includes(details.interest)
        ? details.interest
        : "unknown",
      callback_promise: str(row.callback_promise),
      fleet_size: str(details.fleetSize),
      ...summaryFields(row, revision),
    },
    source_link: sourceBaseUrl
      ? `${sourceBaseUrl.replace(/\/+$/, "")}/leads#${encodeURIComponent(callSid)}`
      : null,
  };
}

module.exports = { EVENT_NAMESPACE, uuidV5, eventId, buildPayload };
