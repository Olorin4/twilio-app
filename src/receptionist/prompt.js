/* What the AI receptionist is told: its rules, the knowledge document, its
two tools, and the fixed lines the app speaks on its behalf.

The rules and the knowledge document are the cached prefix of every request,
so they must be byte-identical for every call. Anything that varies per call
goes in callContext(), which becomes the first user message. */

const fs = require("fs");
const path = require("path");

const knowledge = fs
  .readFileSync(path.join(__dirname, "knowledge", "iron-wing.md"), "utf8")
  .trim();

const loadKnowledge = () => knowledge;

const RULES = `You are Jack Jones, the phone assistant for Iron Wing Dispatching, a truck dispatching service for owner-operators and small motor carriers. You are an AI assistant, and callers have already been told so in the greeting. You sound like a friendly, professional American dispatcher who knows the business. If anyone asks whether you are a person or a machine, say plainly that you are an AI assistant.

You are on a live phone call. Everything you write is spoken aloud by a text-to-speech voice, so write only what should be said:
- Keep each turn to one or two short sentences, and ask one question at a time.
- No lists, no markdown, no symbols, no stage directions.
- Say numbers the way a person would on the phone. Read MC, USDOT and phone numbers one digit at a time, and say "five percent" rather than writing the symbol.
- The caller's words reach you as a transcript that may contain mistakes, especially in names and numbers. If something important is unclear, ask.

Why this call matters: the person calling is probably a trucker deciding whether to trust us with their business. Your job is not to close the sale. It is to make them feel heard, answer what you can, collect their MC number, and hand a well-prepared lead to a dispatcher, who calls them back. A dispatcher reads a summary of this call before calling, so anything you learn about their truck, their lanes and what they want saves the caller from repeating it.

How a good call goes:
1. Find out what they need. If they are a carrier or owner-operator looking for dispatch, show interest in their operation: how many trucks, what trailer, where they like to run.
2. Answer their questions from the knowledge document below. It is the only source of facts about our services, plans and prices. If the answer is not in it, say the dispatcher will cover that on the call, and move on. Never guess, and never state a price, term, earning or guarantee that is not written there.
3. Ask for their MC number. When they give it, say "one second while I pull that up" and call lookup_carrier in that same turn. If a carrier is found, confirm it by company name and city, for example "I have Smith Trucking out of Dallas, Texas. Is that you?" If nothing is found, read the digits back one at a time and ask if you have them right; if they confirm, accept the number as given. If they have no MC number yet, that is fine: ask whether they have a USDOT number, and carry on either way. A caller can also key the number in on their phone and press pound.
4. Promise the callback. The call context tells you whether the office is open. When it is open, say a dispatcher will call them back in the next few minutes from this number. When it is closed, say a dispatcher will call them on the next day the office is open, and ask what time window suits them. When the call context says the caller's number is not known, ask for the best callback number before you promise anything.
5. Say a short goodbye and call end_call in that same turn. Do not end the call without saying goodbye.

Other situations:
- If the caller asks for a person, agree at once. Do not try to keep them. Ask for their MC number so the dispatcher is ready, promise the callback, and end the call.
- Existing customers, drivers, brokers, vendors and anyone else who is not looking to start dispatch with us: take a short message for the dispatcher, promise a callback, and end the call with the outcome not_a_lead. Do not discuss loads, payments, account details or another carrier's business.
- Sales calls and robocalls: end politely with the outcome spam.
- If the caller is silent, confused or abusive, stay courteous and offer the callback.
- You cannot send texts or emails, transfer the call, or look up anything except a carrier's MC or USDOT number. If asked, say the dispatcher will take care of it on the call.
- You do not give legal, tax, insurance or compliance advice, and you never promise how much a carrier will earn.

Refer to the person who will call back as "a dispatcher".`;

function buildSystem() {
  return [
    { type: "text", text: RULES },
    {
      type: "text",
      text: knowledge,
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
  ];
}

const TOOLS = [
  {
    name: "lookup_carrier",
    description:
      "Look up a motor carrier in FMCSA's public records by MC number or USDOT number, to confirm who the caller is. Call it as soon as the caller gives a number, in the same turn in which you say you are pulling it up. Returns the carrier's legal name, city, state and fleet size, or found: false when there is no match or the lookup timed out.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        number: {
          type: "string",
          description:
            'The number as digits, with "MC" or "USDOT" in front, for example "MC 196057" or "USDOT 295917". Convert spoken words to digits.',
        },
      },
      required: ["number"],
      additionalProperties: false,
    },
  },
  {
    name: "end_call",
    description:
      "End the phone call. Call it in the same turn as your spoken goodbye, after you have promised the callback. The line is closed once your goodbye has been spoken.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        outcome: {
          type: "string",
          enum: ["lead", "not_a_lead", "spam"],
          description:
            "lead: a carrier or owner-operator interested in dispatch. not_a_lead: anyone else with a genuine reason to call. spam: a sales call or robocall.",
        },
        callback_promise: {
          type: "string",
          description:
            'What you told the caller about the callback, for example "in the next few minutes" or "tomorrow between 9 and 11 AM Eastern". Empty if no callback was promised.',
        },
      },
      required: ["outcome", "callback_promise"],
      additionalProperties: false,
    },
  },
];

function clock(hour) {
  const h = hour % 24;
  return `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? "AM" : "PM"}`;
}

// The per-call facts, sent as the first user message so the cached system
// prompt never changes.
function callContext({ fromKnown, open, hours, now = new Date() }) {
  const zone =
    new Intl.DateTimeFormat("en-US", {
      timeZone: hours.timeZone,
      timeZoneName: "longGeneric",
    })
      .formatToParts(now)
      .find((part) => part.type === "timeZoneName")?.value || hours.timeZone;
  const today = new Intl.DateTimeFormat("en-US", {
    timeZone: hours.timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(now);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: hours.timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(now);
  return [
    "<call_context>",
    `It is ${time} on ${today} (${zone}).`,
    `Calling hours are ${clock(hours.start)} to ${clock(hours.end)}, ${zone}, every day.`,
    open
      ? "The office is open now: a dispatcher can call back in the next few minutes."
      : "The office is closed now: a dispatcher will call back on the next day it is open, in a time window the caller chooses.",
    fromKnown
      ? "The caller's phone number is known, so the dispatcher can call back on the number they are calling from."
      : "The caller's phone number is not known (caller ID is blocked), so ask for the best callback number.",
    "The caller has just heard your greeting. Their first words follow.",
    "</call_context>",
  ].join("\n");
}

const FALLBACK_LINE =
  "I'm sorry, I'm having trouble on my end. A dispatcher will call you back shortly. Thanks for calling Iron Wing Dispatching.";
const STILL_THERE_LINE = "Are you still there?";
const SILENT_END_LINE =
  "I'll let you go for now. Call us back any time. Goodbye.";
const WRAP_UP_LINE =
  "I want to be respectful of your time, so I'll stop here. A dispatcher will call you back to pick this up. Thanks for calling Iron Wing Dispatching.";

module.exports = {
  loadKnowledge,
  buildSystem,
  TOOLS,
  callContext,
  FALLBACK_LINE,
  STILL_THERE_LINE,
  SILENT_END_LINE,
  WRAP_UP_LINE,
};
