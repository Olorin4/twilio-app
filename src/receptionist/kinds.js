/* The kinds of AI agent a workspace can put on a number, and what each kind
may do: the outcomes it ends a call with and the tools it is given.

  receptionist  a company's public line (Jack): leads and other callers
  dispatcher    a dispatch line: messages, some of them urgent
  support       a software support line: no carrier lookup */

const KINDS = ["receptionist", "dispatcher", "support"];

const SPAM = "spam: a sales call or robocall.";

const OUTCOMES = {
  receptionist: {
    list: ["lead", "not_a_lead", "spam"],
    description: `lead: a carrier or owner-operator interested in dispatch. not_a_lead: anyone else with a genuine reason to call. ${SPAM}`,
  },
  dispatcher: {
    list: ["message", "urgent", "spam"],
    description: `message: a caller with a genuine reason to call whose matter can wait for the callback. urgent: a problem that cannot wait, such as trouble on a load that is moving now. ${SPAM}`,
  },
  support: {
    list: ["support_request", "not_support", "prospect", "spam"],
    description: `support_request: a customer or user who needs help with the product or their account. not_support: anyone else with a genuine reason to call. prospect: someone who wants to buy or try the product, such as a company asking what it does or what it costs. ${SPAM}`,
  },
};

// Outcomes that send the alert email; spam and not_support send nothing.
// A support line's sales prospect is emailed so sales can follow up.
const EMAILED_OUTCOMES = [
  "lead",
  "not_a_lead",
  "message",
  "urgent",
  "support_request",
  "prospect",
];

// Who calls the caller back, as the prompt and the fixed lines say it.
const CALLBACK_PERSON = {
  receptionist: { a: "a dispatcher", the: "the dispatcher" },
  dispatcher: { a: "a dispatcher", the: "the dispatcher" },
  support: { a: "someone from our team", the: "our team" },
};

function check(kind) {
  if (!KINDS.includes(kind)) throw new Error(`unknown agent kind: ${kind}`);
  return kind;
}

const outcomesFor = (kind) => [...OUTCOMES[check(kind)].list];

// Never throws: the fixed lines are spoken when something has gone wrong.
const callbackPerson = (kind) =>
  CALLBACK_PERSON[kind] || CALLBACK_PERSON.receptionist;

const LOOKUP_CARRIER = {
  name: "lookup_carrier",
  description:
    "Look up a motor carrier in FMCSA's public records by MC number or USDOT number, to confirm who the caller is. Call it as soon as the caller gives a number; the caller hears a short holding line while it runs. Returns the carrier's legal name, city, state and fleet size, or found: false when there is no match or the lookup timed out.",
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
};

const GOODBYE_EXAMPLE = {
  receptionist:
    '"Thanks, Mike. A dispatcher will call you in the next few minutes. Drive safe."',
  dispatcher:
    '"Thanks, Mike. A dispatcher will call you in the next few minutes. Drive safe."',
  support:
    '"Thanks, Mike. Someone from our team will call you back shortly. Have a good day."',
};

function endCall(kind, offerIntake) {
  return {
    name: "end_call",
    description:
      "End the phone call, after you have promised the callback. The text in the goodbye field is spoken to the caller, then the line is closed.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        outcome: {
          type: "string",
          enum: outcomesFor(kind),
          description: OUTCOMES[kind].description,
        },
        callback_promise: {
          type: "string",
          description:
            'What you told the caller about the callback, for example "in the next few minutes" or "tomorrow between 9 and 11 AM Eastern". Empty if no callback was promised.',
        },
        ...(offerIntake && {
          offer_callback_requested: {
            type: "boolean",
            description:
              "True only for an explicit callback request about the Iron Wing Black Friday offer.",
          },
          offer_callback_number: {
            type: "string",
            description:
              "The caller's chosen callback number, or empty to use caller ID.",
          },
        }),
        goodbye: {
          type: "string",
          description: `Your closing words, spoken to the caller exactly as written. One or two short sentences, for example ${GOODBYE_EXAMPLE[kind]}`,
        },
      },
      required: [
        "outcome",
        "callback_promise",
        ...(offerIntake
          ? ["offer_callback_requested", "offer_callback_number"]
          : []),
        "goodbye",
      ],
      additionalProperties: false,
    },
  };
}

// Fresh objects on every call, so no caller can change another's tools.
function toolsFor(kind, offerIntake = false) {
  check(kind);
  const tools = kind === "support" ? [] : [structuredClone(LOOKUP_CARRIER)];
  return [...tools, endCall(kind, kind === "receptionist" && offerIntake)];
}

// Receptionists keep RECEPTIONIST_DAILY_LIMIT (config.dailyLimit, default 3);
// the other kinds answer a business's own callers, so they get 20.
function defaultDailyLimit(kind, config = {}) {
  if (kind === "receptionist") return config.dailyLimit ?? 3;
  return 20;
}

module.exports = {
  KINDS,
  outcomesFor,
  toolsFor,
  EMAILED_OUTCOMES,
  defaultDailyLimit,
  callbackPerson,
};
