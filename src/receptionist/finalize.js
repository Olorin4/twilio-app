/* What happens once a call with the AI receptionist is over: summarise it,
save the lead card, tell the softphone, and email the owner. Each step is
allowed to fail without taking the others down, because the one thing that
must not happen is a lead being lost. */

const store = require("./store");
const { getConfig } = require("./config");
const { publish } = require("../messageEvents");

const NO_SUMMARY = "Summary unavailable — read the transcript.";
// Outcomes the owner is emailed about. A failed call is included because the
// fallback line the caller heard promises a callback.
const ALERTED = ["lead", "not_a_lead", "failed"];

async function finalize(result, context, deps = {}) {
  const {
    client,
    config = getConfig(),
    summarize = require("./summary").summarize,
    sendLeadEmail = require("./alertEmail").sendLeadEmail,
  } = deps;
  const { callSid, transcript } = result;

  // Nobody spoke: record it, and spend nothing on a summary.
  if (!result.callerSpoke) {
    try {
      await store.finishCall(callSid, { outcome: "abandoned", transcript });
      publish();
    } catch (error) {
      console.error("Receptionist call save failed:", error.message);
    }
    return;
  }

  let summary = null;
  if (client) {
    try {
      summary = await summarize({
        client,
        config,
        transcript,
        carrier: result.carrier,
        context,
      });
    } catch (error) {
      console.error("Receptionist summary failed:", error.message);
    }
  }

  const carrier = result.carrier?.found ? result.carrier : null;
  const fields = {
    // A session that failed stays failed, whatever the transcript suggests.
    outcome:
      result.outcome === "failed"
        ? "failed"
        : summary?.outcome || result.outcome,
    callerName: summary?.caller_name || null,
    company: summary?.company || carrier?.legalName || null,
    // What FMCSA confirmed wins over what speech recognition heard.
    mcNumber: carrier?.mc || summary?.mc_number || null,
    usdot: carrier?.usdot || summary?.usdot || null,
    mcVerified: Boolean(carrier),
    callbackNumber: summary?.callback_number || null,
    callbackPromise:
      summary?.callback_promise || result.callbackPromise || null,
    carrier,
    details: summary
      ? {
          fleetSize: summary.fleet_size,
          equipment: summary.equipment,
          situation: summary.situation,
          questions: summary.questions,
          unanswered: summary.unanswered,
          interest: summary.interest,
        }
      : null,
    summary: summary?.summary || NO_SUMMARY,
    script: summary?.script || null,
    transcript,
  };

  let row;
  try {
    row = await store.finishCall(callSid, fields);
    publish();
  } catch (error) {
    console.error("Receptionist call save failed:", error.message);
    // The card could not be saved; the email is now the only record.
    row = {
      call_sid: callSid,
      from_number: context?.from,
      outcome: fields.outcome,
      caller_name: fields.callerName,
      company: fields.company,
      mc_number: fields.mcNumber,
      usdot: fields.usdot,
      mc_verified: fields.mcVerified,
      callback_number: fields.callbackNumber,
      callback_promise: fields.callbackPromise,
      details: fields.details,
      summary: fields.summary,
      script: fields.script,
    };
  }
  // No row means the call was already closed, and already alerted.
  if (!row || !ALERTED.includes(fields.outcome)) return;
  try {
    await sendLeadEmail(row, config);
  } catch (error) {
    console.error("Lead email failed:", error.message);
  }
}

module.exports = { finalize, NO_SUMMARY };
