/* What happens once a call with the AI receptionist is over: save it, tell
the softphone, summarise it, and email the owner.

The call is saved first, with its transcript, because everything after that
depends on a model request that can be slow or fail - and the one thing that
must not happen is a lead being lost. Each later step is allowed to fail
without taking the others down. */

const store = require("./store");
const { getConfig } = require("./config");
const { addUsage, claudeCost, relayCost } = require("./costs");
const { publish } = require("../messageEvents");

const { NO_SUMMARY } = require("./noSummary");
const EMAILED_AFTER_SUMMARY = ["lead", "not_a_lead"];

// The shape the lead email reads, for when no saved row is available.
const asRow = (callSid, context, fields, transcript) => ({
  call_sid: callSid,
  from_number: context?.from,
  outcome: fields.outcome,
  caller_name: fields.callerName || null,
  company: fields.company || null,
  mc_number: fields.mcNumber || null,
  usdot: fields.usdot || null,
  mc_verified: Boolean(fields.mcVerified),
  callback_number: fields.callbackNumber || null,
  callback_promise: fields.callbackPromise || null,
  details: fields.details || null,
  summary: fields.summary || null,
  script: fields.script || null,
  transcript,
});

async function finalize(result, context, deps = {}) {
  const {
    client,
    config = getConfig(),
    summarize = require("./summary").summarize,
    sendLeadEmail = require("./alertEmail").sendLeadEmail,
  } = deps;
  const { callSid, transcript } = result;
  // The live call's token counts; the summary request adds its own below.
  const usage = (result.usage || []).map((entry) => ({ ...entry }));
  // Stores what the call cost. `closed` is the saved row, whose start and end
  // times give the ConversationRelay minutes. Never throws.
  const recordCosts = async (closed) => {
    try {
      const seconds =
        closed?.started_at && closed?.ended_at
          ? (new Date(closed.ended_at) - new Date(closed.started_at)) / 1000
          : null;
      await store.saveCosts(callSid, {
        usage,
        claudeCost: claudeCost(usage),
        relayCost: relayCost(seconds, config.relayRate),
      });
    } catch (error) {
      console.error("Receptionist cost save failed:", error.message);
    }
  };
  const email = async (row) => {
    try {
      await sendLeadEmail(row, config);
    } catch (error) {
      console.error("Lead email failed:", error.message);
    }
  };

  // Nobody spoke: record it, and spend nothing on a summary.
  if (!result.callerSpoke) {
    try {
      const closed = await store.finishCall(callSid, {
        outcome: "abandoned",
        transcript,
      });
      publish();
      // The greeting and the pre-warmed prompt were still paid for.
      if (closed) await recordCosts(closed);
    } catch (error) {
      console.error("Receptionist call save failed:", error.message);
    }
    return;
  }

  // 1. Save what is already known.
  const carrier = result.carrier?.found ? result.carrier : null;
  const known = {
    outcome: result.outcome,
    company: carrier?.legalName || null,
    mcNumber: carrier?.mc || null,
    usdot: carrier?.usdot || null,
    mcVerified: Boolean(carrier),
    callbackPromise: result.callbackPromise || null,
    carrier,
    transcript,
  };
  let saved = false;
  let row;
  let closed = null;
  try {
    row = await store.finishCall(callSid, known);
    // No row means the call was already closed, and already dealt with.
    if (!row) return;
    closed = row;
    saved = true;
    publish();
  } catch (error) {
    console.error("Receptionist call save failed:", error.message);
    // The card could not be saved; the email is now the only record.
    row = asRow(callSid, context, known, transcript);
  }

  // The caller of a failed call was told a dispatcher would call back
  // shortly, and the model that just failed may fail the summary too: tell
  // the owner now.
  const failed = result.outcome === "failed";
  if (failed) await email(row);

  // 2. Summarise.
  let summary = null;
  if (client) {
    try {
      summary = await summarize({
        client,
        config,
        transcript,
        carrier: result.carrier,
        context,
        onUsage: (message) => addUsage(usage, message),
      });
    } catch (error) {
      console.error("Receptionist summary failed:", error.message);
    }
  }

  // What FMCSA has on record wins over what speech recognition heard, but
  // only when the caller agreed the record is theirs.
  const confirmed =
    carrier && (!summary || summary.carrier_confirmed !== false)
      ? carrier
      : null;
  const fields = {
    // A session that failed stays failed, whatever the transcript suggests.
    outcome: failed ? "failed" : summary?.outcome || result.outcome,
    callerName: summary?.caller_name || null,
    company: summary?.company || confirmed?.legalName || null,
    mcNumber: confirmed?.mc || summary?.mc_number || null,
    usdot: confirmed?.usdot || summary?.usdot || null,
    mcVerified: Boolean(confirmed),
    callbackNumber: summary?.callback_number || null,
    callbackPromise:
      summary?.callback_promise || result.callbackPromise || null,
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
  };

  // 3. Add the summary to the card.
  row = asRow(callSid, context, fields, transcript);
  if (saved) {
    try {
      row = (await store.updateSummary(callSid, fields)) || row;
      publish();
    } catch (error) {
      console.error("Receptionist summary save failed:", error.message);
    }
  }

  // 4. Email the owner (a failed call was emailed above).
  if (EMAILED_AFTER_SUMMARY.includes(fields.outcome)) await email(row);

  // 5. Record what the call cost, last: nothing above waits on it.
  if (closed) await recordCosts(closed);
}

module.exports = { finalize, NO_SUMMARY };
