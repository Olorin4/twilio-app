/* After a call: one Claude request that turns the transcript into the lead
card - who called, what they want, and a script for the dispatcher's
callback. Not on the live path, so it favours accuracy over speed. */

const { z } = require("zod");
const { zodOutputFormat } = require("@anthropic-ai/sdk/helpers/zod");
const { loadKnowledge } = require("./prompt");

const LeadSummary = z.object({
  outcome: z.enum(["lead", "not_a_lead", "spam"]),
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

const INSTRUCTIONS = `You prepare a dispatcher at Iron Wing Dispatching for a callback. A caller has just spoken with Jack, the company's AI phone assistant. From the transcript, the FMCSA carrier record (when there is one) and the company knowledge document, fill in the lead card.

The dispatcher reads this in the minute before calling back, so be specific and brief, and write only what the material supports:
- Take facts about the caller only from the transcript and the carrier record. Use null (or "unknown" for interest) when something was not said. Do not guess a name, company or number. The transcript comes from speech recognition, so names and numbers may be misspelled; when the carrier record gives the company name or MC number, prefer it.
- outcome: "lead" for a carrier or owner-operator interested in dispatch, "not_a_lead" for anyone else with a genuine reason to call (existing customer, driver, broker, vendor), "spam" for sales calls and robocalls.
- callback_number: only a number the caller gave during the call, in the form +1XXXXXXXXXX. Otherwise null.
- callback_promise: what Jack told the caller about when they will be called back, or null if nothing was promised.
- questions: what the caller asked or objected to. unanswered: the questions Jack could not answer.
- summary: three to five short lines on who they are, what they run and what they want.
- script: a suggested callback for the dispatcher, in the dispatcher's own first-person voice. opener greets the caller by name if known and refers to their call. points are the two to four things worth saying to this caller. objections pairs each concern they raised with an answer. next_step is the one thing to ask for at the end of the call.
- Every statement about services, plans or prices in the script must come from the knowledge document below. If the document does not cover something the caller asked, do not invent an answer: say in the script that the dispatcher should answer it personally.
- For a caller who is not a lead, keep the script to what they need from the callback.`;

function formatCall({ transcript, carrier, context }) {
  const lines = (transcript || [])
    .map(
      (turn) => `${turn.role === "caller" ? "Caller" : "Jack"}: ${turn.text}`,
    )
    .join("\n");
  return [
    `Caller's phone number: ${context?.from || "unknown"}`,
    `FMCSA carrier record: ${carrier?.found ? JSON.stringify(carrier) : "none found"}`,
    "",
    "<transcript>",
    lines,
    "</transcript>",
  ].join("\n");
}

// Resolves with the lead card, or null when it could not be produced. Never
// throws: a missing summary must not cost the owner the lead.
async function summarize({ client, config, transcript, carrier, context }) {
  try {
    const response = await client.messages.parse({
      model: config.summaryModel,
      max_tokens: 16000,
      system: [
        { type: "text", text: INSTRUCTIONS },
        {
          type: "text",
          text: `<knowledge_document>\n${loadKnowledge()}\n</knowledge_document>`,
        },
      ],
      messages: [
        { role: "user", content: formatCall({ transcript, carrier, context }) },
      ],
      output_config: { format: zodOutputFormat(LeadSummary) },
    });
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

module.exports = { LeadSummary, summarize };
