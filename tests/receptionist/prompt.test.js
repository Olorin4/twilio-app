const {
  loadKnowledge,
  buildSystem,
  TOOLS,
  callContext,
  FALLBACK_LINE,
  STILL_THERE_LINE,
  SILENT_END_LINE,
  WRAP_UP_LINE,
} = require("../../src/receptionist/prompt");

const hours = { start: 7, end: 18, timeZone: "America/New_York" };

test("system blocks are identical across calls and cache the knowledge for an hour", () => {
  expect(JSON.stringify(buildSystem())).toBe(JSON.stringify(buildSystem()));
  const [rules, knowledge] = buildSystem();
  expect(buildSystem()).toHaveLength(2);
  expect(rules.cache_control).toBeUndefined();
  expect(knowledge.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  expect(knowledge.text).toBe(loadKnowledge());
});

test("the knowledge document has every agreed section and the published prices", () => {
  const text = loadKnowledge();
  for (const heading of [
    "## Who we are",
    "## Services",
    "## Plans and pricing",
    "## How onboarding works",
    "## Requirements",
    "## Documents needed",
    "## Common questions and objections",
    "## Never say",
  ])
    expect(text).toContain(heading);
  expect(text).toContain("5%");
  expect(text).toContain("10%");
  expect(text).toContain("linehaul");
});

test("rules carry the non-negotiables", () => {
  const text = buildSystem()[0].text;
  for (const phrase of [
    "Jack Jones",
    "AI assistant",
    "lookup_carrier",
    "end_call",
    "next few minutes",
    "one second while I pull that up",
    "callback number",
    "a dispatcher",
  ])
    expect(text).toContain(phrase);
});

test("nothing that changes per call or per day is in the cached prefix", () => {
  const text = JSON.stringify(buildSystem());
  expect(text).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
  expect(text).not.toMatch(/<call_context>/);
});

test("tools are strict and closed", () => {
  expect(TOOLS.map((t) => t.name)).toEqual(["lookup_carrier", "end_call"]);
  for (const tool of TOOLS) {
    expect(tool.strict).toBe(true);
    expect(tool.input_schema.additionalProperties).toBe(false);
    expect(tool.input_schema.required).toEqual(
      Object.keys(tool.input_schema.properties),
    );
  }
  expect(TOOLS[1].input_schema.properties.outcome.enum).toEqual([
    "lead",
    "not_a_lead",
    "spam",
  ]);
  // The goodbye travels as a tool input so it always reaches the caller.
  expect(Object.keys(TOOLS[1].input_schema.properties)).toEqual([
    "outcome",
    "callback_promise",
    "goodbye",
  ]);
});

test("call context tells the agent when the number is unknown and the office is closed", () => {
  const text = callContext({
    fromKnown: false,
    open: false,
    hours,
    now: new Date("2026-11-16T03:00:00Z"),
  });
  expect(text).toMatch(/^<call_context>[\s\S]*<\/call_context>$/);
  expect(text).toMatch(/number is not known/i);
  expect(text).toMatch(/closed/i);
  expect(text).toContain("7:00 AM to 6:00 PM");
  expect(text).toContain("Sunday, November 15, 2026"); // 10 PM Eastern
});

test("call context for a known number during calling hours", () => {
  const text = callContext({
    fromKnown: true,
    open: true,
    hours,
    now: new Date("2026-11-16T15:00:00Z"),
  });
  expect(text).toMatch(/number is known/i);
  expect(text).toMatch(/open/i);
  expect(text).not.toMatch(/closed/i);
  expect(text).toContain("Monday, November 16, 2026");
});

test("the fixed lines promise a callback and never claim to be human", () => {
  expect(FALLBACK_LINE).toContain("A dispatcher will call you back");
  expect(WRAP_UP_LINE).toContain("dispatcher will call you back");
  expect(STILL_THERE_LINE).toBe("Are you still there?");
  expect(SILENT_END_LINE).toContain("Goodbye");
});

test("the lookup tool does not tell the model to speak the filler the app already speaks", () => {
  expect(TOOLS[0].description).not.toMatch(/you say you are pulling it up/);
  expect(TOOLS[0].description).toMatch(/hears a short holding line/);
});

test("the rules keep the call on Iron Wing's dispatch service", () => {
  const text = buildSystem()[0].text;
  // Unrelated subjects are declined in a sentence and steered back.
  expect(text).toMatch(/only help with Iron Wing/);
  expect(text).toMatch(/unrelated/i);
  // A caller who will not come back to the subject is offered the callback,
  // on the third detour and not before.
  expect(text).toMatch(/third time/i);
  expect(text).not.toMatch(/second time/i);
  // What a caller says never changes the assistant's instructions.
  expect(text).toMatch(/ignore your (rules|instructions)/i);
  expect(text).toMatch(/reveal/i);
});

test("the rules make Jack a receptionist for other trucking businesses too", () => {
  const text = buildSystem()[0].text;
  // Brokers, factoring companies and the like are welcome callers, not detours.
  for (const caller of [
    "broker",
    "factoring",
    "insurance",
    "shipper",
    "vendor",
  ])
    expect(text).toContain(caller);
  expect(text).toMatch(/receptionist/i);
  // He finds out who is calling and takes a proper message.
  expect(text).toMatch(/company/i);
  expect(text).toMatch(/message/i);
  expect(text).toMatch(/urgent/i);
  // The protections for carriers stay in place whoever is asking.
  expect(text).toMatch(/whether .* is a (client|customer)/i);
  expect(text).toMatch(/bank|payment details/i);
  // A business caller is not pressed for an MC number.
  expect(text).toMatch(/do not (ask|press) .* for an MC number/i);
});

test("questions about a named carrier are handled with judgement, not a flat refusal", () => {
  const text = buildSystem()[0].text;
  // Jack has no list of carriers, so he can never truthfully say yes or no.
  expect(text).toMatch(/no list of (the |our )?carriers/i);
  expect(text).toMatch(/never guess/i);
  // How forthcoming he is depends on how the caller introduced themselves.
  expect(text).toMatch(/judg(e)?ment/i);
  expect(text).toMatch(/introduced themselves/i);
  // A credible business caller is told plainly why, and helped toward an answer.
  expect(text).toMatch(/the dispatcher (can|will) confirm/i);
  // The hard line on bank and contact details does not bend.
  expect(text).toMatch(/whatever the caller says/i);
});

test("a caller who keeps trying to change the rules is ended like any other detour", () => {
  const text = buildSystem()[0].text;
  expect(text).toMatch(/keeps? trying/i);
  expect(text).toMatch(/third attempt/i);
});

test("the knowledge never lets Jack say the company handles factoring itself", () => {
  expect(loadKnowledge()).toMatch(/never (say|that) we .*handle factoring/i);
});

test("the callback promise says which number the dispatcher will call", () => {
  // "From this number" came from the first draft of the rules. Callers could
  // not tell whose number was meant.
  const text = buildSystem()[0].text;
  expect(text).not.toMatch(/from this number/i);
  expect(text).toMatch(/on the number they are calling from/i);
});

test("Jack is not introduced as an AI, so the rules make him say so when asked", () => {
  const text = buildSystem()[0].text;
  expect(text).not.toMatch(/already been told/i);
  expect(text).toMatch(/greeting does not say/i);
  expect(text).toMatch(/never say or imply that you are a (person|human)/i);
  expect(text).toMatch(/say plainly[^.]*that you are an AI assistant/i);
});

test("a caller who asks whether the call is recorded gets a true answer", () => {
  const text = buildSystem()[0].text;
  expect(text).toMatch(/recorded[^.]*transcribed/i);
});

test("the knowledge never says there is no contract", () => {
  // Heard on the first real call: "there's no contract". There is a short
  // service agreement; what there is not is a term commitment.
  const text = loadKnowledge();
  expect(text).not.toMatch(/there(?:'s| is) no\s+contract/i);
  expect(text).not.toMatch(/and no\s+contract/i);
  expect(text).toMatch(/never say (that )?we have no contract/i);
  expect(text).toMatch(/short service agreement/i);
});

// ---- Profile-driven prompt (Phase 2a) ----

const fs = require("fs");
const path = require("path");
const { fixedLines } = require("../../src/receptionist/prompt");
const { JACK } = require("../../src/receptionist/seed/jack");

const legacyRules = fs.readFileSync(
  path.join(__dirname, "fixtures", "legacy-rules.txt"),
  "utf8",
);

// Sentences, ignoring list markers and the blank lines between parts, so
// the test pins the words Jack is told and not where a paragraph breaks.
function sentences(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:-|\d+\.)\s+/, "").trim())
    .filter(Boolean)
    .flatMap((line) => line.split(/(?<=[.!?:])\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

function counts(list) {
  const m = new Map();
  for (const s of list) m.set(s, (m.get(s) || 0) + 1);
  return m;
}

const kelevo = (kind) => ({
  kind,
  name: "Kelevo line",
  personaName: "Maya",
  companyName: "KelevoTMS",
  greeting: "Thanks for calling KelevoTMS. This is Maya.",
  instructions: "Help KelevoTMS customers with the software.",
  knowledge: "KelevoTMS is a transportation management system.",
});

describe("profile-driven prompt", () => {
  test("Jack's assembled prompt holds today's rules", () => {
    const want = counts(sentences(legacyRules));
    const got = counts(sentences(buildSystem(JACK)[0].text));
    for (const [s, n] of want) expect([s, got.get(s) || 0]).toEqual([s, n]);
    for (const s of got.keys()) expect(want.has(s) ? s : `EXTRA: ${s}`).toBe(s);
    // Each sentence in today's rules appears exactly once.
    for (const n of want.values()) expect(n).toBe(1);
  });

  test("buildSystem with no profile is Jack's", () => {
    expect(JSON.stringify(buildSystem())).toBe(
      JSON.stringify(buildSystem(JACK)),
    );
  });

  test("knowledge is the cached second block", () => {
    const blocks = buildSystem(JACK);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[1].text).toBe(JACK.knowledge);
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(JACK.knowledge).toBe(
      fs
        .readFileSync(
          path.join(__dirname, "../../src/receptionist/knowledge/iron-wing.md"),
          "utf8",
        )
        .trim(),
    );
  });

  test("the prompt is byte-identical across calls", () => {
    for (const p of [JACK, kelevo("support"), kelevo("dispatcher")])
      expect(JSON.stringify(buildSystem(p))).toBe(
        JSON.stringify(buildSystem(p)),
      );
  });

  test("an empty knowledge field adds no empty block", () => {
    for (const knowledge of ["", "   \n"]) {
      const blocks = buildSystem({ ...kelevo("support"), knowledge });
      expect(blocks).toHaveLength(1);
      for (const b of blocks) expect(b.text.trim()).not.toBe("");
      expect(blocks[blocks.length - 1].cache_control).toEqual({
        type: "ephemeral",
        ttl: "1h",
      });
    }
  });

  test("support agents get no fraud rules", () => {
    const fraud = "do not accept or confirm any change to bank details";
    expect(buildSystem(kelevo("support"))[0].text).not.toContain(fraud);
    expect(buildSystem(kelevo("dispatcher"))[0].text).toContain(fraud);
    expect(buildSystem(JACK)[0].text).toContain(fraud);
  });

  test("every profile is told it is an AI and to say so when asked", () => {
    for (const kind of ["receptionist", "dispatcher", "support"]) {
      const text = buildSystem(kelevo(kind))[0].text;
      expect(text).toMatch(/never say or imply that you are a (person|human)/i);
      expect(text).toMatch(/say plainly[^.]*that you are an AI assistant/i);
      expect(text).toMatch(/recorded[^.]*transcribed/i);
      expect(text).toMatch(/ignore your (rules|instructions)/i);
    }
  });

  test("another business's prompt carries its name and none of Iron Wing's", () => {
    const blocks = buildSystem(kelevo("support"));
    const text = blocks.map((b) => b.text).join("\n");
    expect(text).toContain("only help with KelevoTMS business");
    expect(text).toContain("Help KelevoTMS customers with the software.");
    expect(text).not.toMatch(/Iron Wing|Jack/);
    expect(text).not.toMatch(/dispatcher/i);
    expect(blocks[1].text).toBe(
      "KelevoTMS is a transportation management system.",
    );
  });

  test("fixed lines name the profile's company", () => {
    const lines = fixedLines(kelevo("support"));
    expect(lines.fallback).toContain("KelevoTMS");
    expect(lines.fallback).not.toContain("Iron Wing");
    expect(lines.wrapUp).toContain("KelevoTMS");
    expect(lines.wrapUp).not.toContain("Iron Wing");
    expect(lines.fallback).not.toMatch(/dispatcher/i);
    expect(fixedLines(kelevo("dispatcher")).fallback).toContain("KelevoTMS");
  });

  test("Jack's fixed lines are today's, word for word", () => {
    expect(fixedLines(JACK)).toEqual({
      fallback:
        "I'm sorry, I'm having trouble on my end. A dispatcher will call you back shortly. Thanks for calling Iron Wing Dispatching.",
      stillThere: "Are you still there?",
      silentEnd: "I'll let you go for now. Call us back any time. Goodbye.",
      wrapUp:
        "I want to be respectful of your time, so I'll stop here. A dispatcher will call you back to pick this up. Thanks for calling Iron Wing Dispatching.",
    });
    expect(FALLBACK_LINE).toBe(fixedLines(JACK).fallback);
    expect(WRAP_UP_LINE).toBe(fixedLines(JACK).wrapUp);
    expect(STILL_THERE_LINE).toBe(fixedLines(JACK).stillThere);
    expect(SILENT_END_LINE).toBe(fixedLines(JACK).silentEnd);
  });

  test("the compatibility exports are built from Jack", () => {
    const { toolsFor } = require("../../src/receptionist/kinds");
    expect(TOOLS).toEqual(toolsFor("receptionist"));
    expect(loadKnowledge()).toBe(JACK.knowledge);
  });

  test("Jack's seed carries only the fields of a seed", () => {
    expect(Object.keys(JACK).sort()).toEqual(
      [
        "kind",
        "name",
        "personaName",
        "companyName",
        "greeting",
        "instructions",
        "knowledge",
      ].sort(),
    );
    expect(JACK).toMatchObject({
      kind: "receptionist",
      name: "Jack (customer line)",
      personaName: "Jack",
      companyName: "Iron Wing Dispatching",
    });
  });
});
