/* After a call: one Claude request that turns the transcript into the card
the owner reads - who called, what they want, and what to say or do on the
callback. Not on the live path, so it favours accuracy over speed.

Every kind of agent fills the same card; only the outcomes it may choose and
the instructions differ. A receptionist (Jack) gets a lead card with a sales
script; a dispatcher or support line gets a message card with a to-do. The
names in the instructions and the knowledge document come from the call's
agent profile, never from Jack's. */

const { z } = require("zod");
const { zodOutputFormat } = require("@anthropic-ai/sdk/helpers/zod");
const { outcomesFor, callbackPerson } = require("./kinds");

const summarySchema = (kind) =>
  z.object({
    outcome: z.enum(outcomesFor(kind)),
    caller_name: z.string().nullable(),
    company: z.string().nullable(),
    mc_number: z.string().nullable(),
    usdot: z.string().nullable(),
    callback_number: z.string().nullable(),
    fleet_size: z.string().nullable(),
    equipment: z.string().nullable(),
    situation: z.string(),
    questions: z.array(z.string()),
    unanswered: z.array(z.string()),
    interest: z.enum(["high", "medium", "low", "unknown"]),
    callback_promise: z.string().nullable(),
    carrier_confirmed: z.boolean(),
    summary: z.string(),
    script: z.object({
      opener: z.string(),
      points: z.array(z.string()),
      objections: z.array(
        z.object({ objection: z.string(), answer: z.string() }),
      ),
      next_step: z.string(),
    }),
  });

// The receptionist's card, as it was before agent profiles.
const LeadSummary = summarySchema("receptionist");
const SCHEMAS = Object.fromEntries(
  ["receptionist", "dispatcher", "support"].map((kind) => [
    kind,
    summarySchema(kind),
  ]),
);

const REQUEST_OPTIONS = { timeout: 40_000, maxRetries: 0 };

// A receptionist's instructions: Jack's, word for word, with the profile's
// persona and company in place of his.
const receptionistInstructions = ({ personaName: persona, companyName }) =>
  `You prepare a dispatcher at ${companyName} for a callback. A caller has just spoken with ${persona}, the company's AI phone assistant. From the transcript, the FMCSA carrier record (when there is one) and the company knowledge document, fill in the lead card.

The dispatcher reads this in the minute before calling back, so be specific and brief, and write only what the material supports:
- Take facts about the caller only from the transcript and the carrier record. Use null (or "unknown" for interest) when something was not said. Do not guess a name, company or number. The transcript comes from speech recognition, so names and numbers may be misspelled; when the carrier record gives the company name or MC number, prefer it.
- outcome: "lead" for a carrier or owner-operator interested in dispatch, "not_a_lead" for anyone else with a genuine reason to call (existing customer, driver, broker, vendor), "spam" for sales calls and robocalls.
- callback_number: only a number the caller gave during the call, in the form +1XXXXXXXXXX. Otherwise null.
- callback_promise: what ${persona} told the caller about when they will be called back, or null if nothing was promised.
- carrier_confirmed: true only if there is a carrier record and the caller agreed that it is their company. False if they said it was not them, never answered, or there is no record.
- questions: what the caller asked or objected to. unanswered: the questions ${persona} could not answer.
- summary: three to five short lines on who they are, what they run and what they want.
- script: a suggested callback for the dispatcher, in the dispatcher's own first-person voice. The dispatcher is a different person from ${persona} and was not on the call: "I" in the script is the dispatcher, and anything said or promised on the call was said by ${persona}. So write "${persona} said a dispatcher would call you back", never "I said I would call". opener greets the caller by name if known and refers to their call with ${persona}. points are the two to four things worth saying to this caller. objections pairs each concern they raised with an answer. next_step is the one thing to ask for at the end of the call.
- Every statement about services, plans or prices in the script must come from the knowledge document below, in its wording: for example "no term commitment", never "no contract". If ${persona} said something on the call that the document does not support, do not repeat it in the script. If the document does not cover something the caller asked, do not invent an answer: say in the script that the dispatcher should answer it personally.
- For a caller who is not a lead (a broker, a factoring company, an insurance agent, a shipper, a vendor, an existing carrier or a driver), the summary says who they are, which company they are with, what they need, any reference they gave (a load number, a carrier's name, a deadline) and whether it is urgent. Put the company in the company field. Keep the script to what the dispatcher should do on the callback; do not write a sales pitch.`;

// A dispatcher's or support line's instructions: a message card that tells
// the person calling back who called, what they need and what to do, with
// no sales script.
function messageInstructions({ kind, personaName: persona, companyName }) {
  const who = callbackPerson(kind);
  const support = kind === "support";
  const [first, other] = outcomesFor(kind);
  const outcome = support
    ? `"${first}" for a customer or user who needs help with the product or their account, "prospect" for someone who wants to buy or try the product (a company asking what it does or what it costs), "${other}" for anyone else with a genuine reason to call, "spam" for sales calls and robocalls.`
    : `"${first}" for a caller with a genuine reason to call whose matter can wait for the callback, "${other}" for a problem that cannot wait (trouble on a load that is moving now, a breakdown, a missed pickup), "spam" for sales calls and robocalls.`;
  const record = support
    ? ""
    : " and the FMCSA carrier record (when there is one)";
  const facts = support
    ? "Take facts about the caller only from the transcript."
    : "Take facts about the caller only from the transcript and the carrier record.";
  return `You prepare ${who.a} at ${companyName} to return a call. A caller has just spoken with ${persona}, the company's AI phone assistant, who took a message. From the transcript${record} and the company knowledge document, fill in the message card.

The person calling back reads this in the minute before the call, so be specific and brief, and write only what the material supports:
- ${facts} Use null (or "unknown" for interest) when something was not said. Do not guess a name, company or number. The transcript comes from speech recognition, so names and numbers may be misspelled${support ? "" : "; when the carrier record gives the company name or MC number, prefer it"}.
- outcome: ${outcome}
- callback_number: only a number the caller gave during the call, in the form +1XXXXXXXXXX. Otherwise null.
- callback_promise: what ${persona} told the caller about when they will be called back, or null if nothing was promised.
- carrier_confirmed: ${support ? "always false." : "true only if there is a carrier record and the caller agreed that it is their company. False if they said it was not them, never answered, or there is no record."}
- mc_number, usdot, fleet_size and equipment: only when the caller gave them; otherwise null. interest: "unknown" unless the caller made it plain.
- situation: what the caller needs, in one or two sentences, with every reference they gave (${support ? "an account or company name, an order or ticket number, an error message, what they were doing when it happened" : "a load or reference number, a carrier's or driver's name, a pickup or delivery, a deadline"}).
- questions: what the caller asked. unanswered: the questions ${persona} could not answer.
- summary: three to five short lines: who called and from which company, what they need, the references they gave, and how urgent it is.
- script: a short to-do for the person calling back, in their own first-person voice. They are a different person from ${persona} and were not on the call: anything said or promised on the call was said by ${persona}, so write "${persona} said we would call you back", never "I said I would call". opener greets the caller by name if known and says what the call is about. points are the one to four things to check, have ready or do on the callback. objections pairs each concern the caller raised with an answer, or is empty. next_step is the one thing to settle before hanging up.
- Every statement about the company's services or products in the script must come from the knowledge document below. If the document does not cover something the caller asked, do not invent an answer: say in the script that the person calling back should answer it.`;
}

function instructionsFor(profile) {
  return profile.kind === "receptionist"
    ? receptionistInstructions(profile)
    : messageInstructions(profile);
}

function formatCall({ transcript, carrier, context, profile }) {
  const persona = profile.personaName;
  const lines = (transcript || [])
    .map(
      (turn) => `${turn.role === "caller" ? "Caller" : persona}: ${turn.text}`,
    )
    .join("\n");
  return [
    `Caller's phone number: ${context?.from || "unknown"}`,
    // A support line has no carrier lookup.
    ...(profile.kind === "support"
      ? []
      : [
          `FMCSA carrier record: ${carrier?.found ? JSON.stringify(carrier) : "none found"}`,
        ]),
    "",
    "<transcript>",
    lines,
    "</transcript>",
  ].join("\n");
}

// Resolves with the card, or null when it could not be produced (including
// when there is no profile to write it for). Never throws: a missing summary
// must not cost the owner the lead.
async function summarize({
  client,
  config,
  transcript,
  carrier,
  context,
  profile,
  onUsage,
}) {
  if (!profile || !SCHEMAS[profile.kind]) return null;
  try {
    const response = await client.messages.parse(
      {
        model: config.summaryModel,
        max_tokens: 16000,
        system: [
          { type: "text", text: instructionsFor(profile) },
          {
            type: "text",
            text: `<knowledge_document>\n${profile.knowledge || ""}\n</knowledge_document>`,
          },
        ],
        messages: [
          {
            role: "user",
            content: formatCall({ transcript, carrier, context, profile }),
          },
        ],
        output_config: { format: zodOutputFormat(SCHEMAS[profile.kind]) },
      },
      // The owner's alert waits on this request, so it gets one bounded
      // attempt rather than the SDK's ten-minute timeout and retries.
      REQUEST_OPTIONS,
    );
    // The request is billed whether or not it produced a usable summary.
    try {
      onUsage?.(response);
    } catch {
      // Cost bookkeeping must not cost the owner the summary.
    }
    if (response.stop_reason !== "end_turn" || !response.parsed_output) {
      console.error(
        "Receptionist summary unavailable:",
        response.stop_reason || "no output",
      );
      return null;
    }
    return response.parsed_output;
  } catch (error) {
    console.error(
      "Receptionist summary failed:",
      error?.status || error?.name || "error",
    );
    return null;
  }
}

module.exports = { LeadSummary, summarySchema, summarize };
