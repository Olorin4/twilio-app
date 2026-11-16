jest.mock("../../src/receptionist/carrierLookup", () => ({
  ...jest.requireActual("../../src/receptionist/carrierLookup"),
  lookupCarrier: jest.fn(),
}));
const { getConfig } = require("../../src/receptionist/config");
const { buildSystem, TOOLS } = require("../../src/receptionist/prompt");
const {
  createAgent,
  requestParams,
  LOOKUP_FILLER,
} = require("../../src/receptionist/agent");

const config = getConfig({});
const history = [
  { role: "user", content: "<call_context>…</call_context>" },
  { role: "assistant", content: "Thanks for calling." },
  { role: "user", content: "I need a dispatcher" },
];

/* A stand-in for the Anthropic client. Each scripted step is one model
request: { thinking, text: [deltas], tools: [{id,name,input}], stop, error,
hang }. Both the standard and beta surfaces record into client.requests. */
function fakeClient(steps, { prewarmUsage } = {}) {
  const requests = [];
  const created = [];
  function stream(params, options = {}) {
    requests.push(JSON.parse(JSON.stringify(params)));
    const step = steps[requests.length - 1] || { text: [], stop: "end_turn" };
    const listeners = { text: [], streamEvent: [] };
    const emit = (event, value) => {
      for (const listener of listeners[event]) listener(value);
    };
    let rejectFinal;
    const final = new Promise((resolve, reject) => {
      rejectFinal = reject;
      if (step.hang) return;
      const finish = () => {
        if (step.error) return reject(step.error);
        for (const delta of step.text || []) {
          emit("streamEvent", { type: "content_block_delta" });
          emit("text", delta);
        }
        // The stream goes quiet after its text and never completes.
        if (step.stallAfterText) return;
        emit("streamEvent", { type: "message_stop" });
        const content = [];
        if (step.thinking)
          content.push({ type: "thinking", thinking: "", signature: "sig" });
        if ((step.text || []).length)
          content.push({ type: "text", text: step.text.join("") });
        for (const tool of step.tools || [])
          content.push({ type: "tool_use", ...tool });
        resolve({
          content,
          stop_reason: step.stop || "end_turn",
          ...(step.usage
            ? { model: "claude-opus-5-5", usage: step.usage }
            : {}),
        });
      };
      // `ticks`: the reply takes that many seconds, with a stream event
      // arriving every second, before it completes.
      let remaining = step.ticks || 0;
      const tick = () => {
        emit("streamEvent", { type: "content_block_delta" });
        if (--remaining > 0) setTimeout(tick, 1000);
        else finish();
      };
      if (remaining) setTimeout(tick, 1000);
      else setImmediate(finish);
    });
    final.catch(() => {});
    const abort = () =>
      rejectFinal(
        Object.assign(new Error("aborted"), { name: "APIUserAbortError" }),
      );
    options.signal?.addEventListener("abort", abort);
    return {
      on(event, listener) {
        listeners[event]?.push(listener);
        return this;
      },
      finalMessage: () => final,
      abort,
      // What the SDK holds for a reply that has started but not finished.
      get currentMessage() {
        return step.partialUsage
          ? { model: "claude-opus-5-5", usage: step.partialUsage }
          : undefined;
      },
    };
  }
  const create = jest.fn(async (params) => {
    created.push(JSON.parse(JSON.stringify(params)));
    return {
      content: [],
      stop_reason: "max_tokens",
      ...(prewarmUsage
        ? { model: "claude-opus-5-5", usage: prewarmUsage }
        : {}),
    };
  });
  return {
    requests,
    created,
    messages: { stream, create },
    beta: { messages: { stream } },
  };
}

beforeEach(() => jest.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test("text deltas are forwarded as they arrive", async () => {
  const client = fakeClient([
    { text: ["Sure. ", "What's your MC number?"], stop: "end_turn" },
  ]);
  const seen = [];
  const r = await createAgent({ client, config }).runTurn(history, {
    onText: (t) => seen.push(t),
  });
  expect(seen).toEqual(["Sure. ", "What's your MC number?"]);
  expect(r).toMatchObject({
    spoken: "Sure. What's your MC number?",
    end: null,
    carrier: null,
    failed: false,
  });
  expect(r.history).toHaveLength(history.length + 1);
  expect(r.history.at(-1)).toEqual({
    role: "assistant",
    content: [{ type: "text", text: "Sure. What's your MC number?" }],
  });
});

test("the request uses the configured model at low effort with the cached system prompt", async () => {
  const client = fakeClient([{ text: ["Hi."] }]);
  await createAgent({ client, config }).runTurn(history, { onText() {} });
  expect(client.requests[0]).toMatchObject({
    model: "claude-opus-5-5",
    max_tokens: 4096,
    output_config: { effort: "low" },
    system: buildSystem(),
    tools: TOOLS,
    messages: history,
  });
  expect(client.requests[0].tool_choice).toBeUndefined();
});

test("lookup_carrier runs, the caller hears a filler, and the model continues with the result", async () => {
  const lookup = jest.fn().mockResolvedValue({
    found: true,
    legalName: "SMITH TRUCKING",
    city: "DALLAS",
    state: "TX",
  });
  const client = fakeClient([
    {
      tools: [
        { id: "t1", name: "lookup_carrier", input: { number: "MC 196057" } },
      ],
      stop: "tool_use",
    },
    { text: ["I have Smith Trucking out of Dallas, Texas. Is that you?"] },
  ]);
  const seen = [];
  const r = await createAgent({ client, config, lookup }).runTurn(history, {
    onText: (t) => seen.push(t),
  });
  expect(lookup).toHaveBeenCalledWith(
    { kind: "mc", digits: "196057" },
    expect.anything(),
  );
  expect(seen[0]).toBe(LOOKUP_FILLER);
  expect(r.spoken).toBe(
    `${LOOKUP_FILLER} I have Smith Trucking out of Dallas, Texas. Is that you?`,
  );
  expect(r.carrier).toMatchObject({ found: true, legalName: "SMITH TRUCKING" });
  const toolResult = client.requests[1].messages.at(-1).content[0];
  expect(toolResult).toMatchObject({ type: "tool_result", tool_use_id: "t1" });
  expect(toolResult.content).toContain("SMITH TRUCKING");
  expect(toolResult.content).toContain("1 9 6 0 5 7");
});

test("the filler is not added when the model already said something before the lookup", async () => {
  const lookup = jest
    .fn()
    .mockResolvedValue({ found: false, reason: "no_match" });
  const client = fakeClient([
    {
      text: ["Let me check that."],
      tools: [{ id: "t1", name: "lookup_carrier", input: { number: "MC 5" } }],
      stop: "tool_use",
    },
    { text: ["I couldn't find it."] },
  ]);
  const seen = [];
  await createAgent({ client, config, lookup }).runTurn(history, {
    onText: (t) => seen.push(t),
  });
  expect(seen).not.toContain(LOOKUP_FILLER);
});

test("a number that cannot be parsed is reported to the model without a lookup", async () => {
  const lookup = jest.fn();
  const client = fakeClient([
    {
      tools: [
        { id: "t1", name: "lookup_carrier", input: { number: "one two" } },
      ],
      stop: "tool_use",
    },
    { text: ["Could you give me the digits?"] },
  ]);
  const r = await createAgent({ client, config, lookup }).runTurn(history, {
    onText() {},
  });
  expect(lookup).not.toHaveBeenCalled();
  expect(client.requests[1].messages.at(-1).content[0].content).toContain(
    "not_a_number",
  );
  expect(r.carrier).toBeNull();
});

test("a lookup with no match does not become the call's carrier", async () => {
  const lookup = jest
    .fn()
    .mockResolvedValue({ found: false, reason: "timeout" });
  const client = fakeClient([
    {
      tools: [{ id: "t1", name: "lookup_carrier", input: { number: "MC 5" } }],
      stop: "tool_use",
    },
    { text: ["Let me read that back."] },
  ]);
  const r = await createAgent({ client, config, lookup }).runTurn(history, {
    onText() {},
  });
  expect(r.carrier).toBeNull();
});

test("end_call speaks the goodbye and ends the turn without another model request", async () => {
  const client = fakeClient([
    {
      tools: [
        {
          id: "t2",
          name: "end_call",
          input: {
            outcome: "lead",
            callback_promise: "in the next few minutes",
            goodbye: "Thanks, Mike. Talk soon.",
          },
        },
      ],
      stop: "tool_use",
    },
  ]);
  const seen = [];
  const r = await createAgent({ client, config }).runTurn(history, {
    onText: (t) => seen.push(t),
  });
  expect(seen).toEqual(["Thanks, Mike. Talk soon."]);
  expect(r.end).toEqual({
    outcome: "lead",
    callbackPromise: "in the next few minutes",
  });
  expect(r.failed).toBe(false);
  expect(client.requests).toHaveLength(1);
  // The round is closed in history so a continued call stays valid.
  expect(r.history.at(-1).content[0]).toMatchObject({
    type: "tool_result",
    tool_use_id: "t2",
  });
});

test("an end_call with an invalid outcome is rejected back to the model, not acted on", async () => {
  const client = fakeClient([
    {
      tools: [{ id: "t2", name: "end_call", input: { outcome: "won" } }],
      stop: "tool_use",
    },
    { text: ["Anything else?"] },
  ]);
  const r = await createAgent({ client, config }).runTurn(history, {
    onText() {},
  });
  expect(r.end).toBeNull();
  expect(client.requests[1].messages.at(-1).content[0]).toMatchObject({
    type: "tool_result",
    is_error: true,
  });
});

test.each(["refusal", "max_tokens"])(
  "%s is reported as failed, not thrown",
  async (stop) => {
    const r = await createAgent({
      client: fakeClient([{ text: [], stop }]),
      config,
    }).runTurn(history, { onText() {} });
    expect(r.failed).toBe(true);
    expect(r.history).toEqual(history);
  },
);

test("an API error is reported as failed", async () => {
  const client = fakeClient([{ error: new Error("401 invalid x-api-key") }]);
  const r = await createAgent({ client, config }).runTurn(history, {
    onText() {},
  });
  expect(r).toMatchObject({ failed: true, spoken: "", end: null });
});

test("no output within 6 seconds is reported as failed", async () => {
  jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
  const client = fakeClient([{ hang: true }]);
  const pending = createAgent({ client, config }).runTurn(history, {
    onText() {},
  });
  await jest.advanceTimersByTimeAsync(5999);
  let settled = false;
  pending.then(() => (settled = true));
  await Promise.resolve();
  expect(settled).toBe(false);
  await jest.advanceTimersByTimeAsync(2);
  expect((await pending).failed).toBe(true);
});

test("a model that keeps calling tools is stopped after four requests", async () => {
  const lookup = jest
    .fn()
    .mockResolvedValue({ found: false, reason: "no_match" });
  const step = {
    tools: [{ id: "t", name: "lookup_carrier", input: { number: "MC 5" } }],
    stop: "tool_use",
  };
  const client = fakeClient([step, step, step, step, step]);
  const r = await createAgent({ client, config, lookup }).runTurn(history, {
    onText() {},
  });
  expect(client.requests).toHaveLength(4);
  expect(r.failed).toBe(true);
});

test("an aborted turn resolves quietly with what was spoken", async () => {
  const client = fakeClient([{ hang: true }]);
  const controller = new AbortController();
  const pending = createAgent({ client, config }).runTurn(history, {
    onText() {},
    signal: controller.signal,
  });
  controller.abort();
  expect(await pending).toMatchObject({ failed: false, spoken: "", end: null });
});

test("a turn started with an aborted signal makes no request", async () => {
  const client = fakeClient([]);
  const r = await createAgent({ client, config }).runTurn(history, {
    onText() {},
    signal: AbortSignal.abort(),
  });
  expect(client.requests).toHaveLength(0);
  expect(r.failed).toBe(false);
});

test("thinking blocks are kept inside a tool round and dropped from the returned history", async () => {
  const lookup = jest
    .fn()
    .mockResolvedValue({ found: false, reason: "no_match" });
  const client = fakeClient([
    {
      thinking: true,
      tools: [{ id: "t1", name: "lookup_carrier", input: { number: "MC 5" } }],
      stop: "tool_use",
    },
    { thinking: true, text: ["Hi."] },
  ]);
  const r = await createAgent({ client, config, lookup }).runTurn(history, {
    onText() {},
  });
  expect(JSON.stringify(client.requests[1].messages)).toContain('"thinking"');
  expect(JSON.stringify(r.history)).not.toContain('"thinking"');
});

test("system and tools are byte-identical across requests", async () => {
  const client = fakeClient([{ text: ["One."] }, { text: ["Two."] }]);
  const agent = createAgent({ client, config });
  const first = await agent.runTurn(history, { onText() {} });
  await agent.runTurn([...first.history, { role: "user", content: "ok" }], {
    onText() {},
  });
  const [a, b] = client.requests;
  expect(JSON.stringify(a.system)).toBe(JSON.stringify(b.system));
  expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
});

test.each([
  ["claude-opus-5-5", "off", undefined],
  ["claude-sonnet-5-5", "off", { type: "between_tools" }],
  ["claude-haiku-5-5", "off", { type: "disabled" }],
  ["claude-sonnet-5-5", "default", undefined],
])("thinking for %s/%s", (liveModel, liveThinking, expected) => {
  expect(
    requestParams({ ...config, liveModel, liveThinking }).thinking,
  ).toEqual(expected);
});

test("fast mode applies to Opus only", () => {
  expect(requestParams({ ...config, liveSpeed: "fast" }).speed).toBe("fast");
  expect(requestParams(config).speed).toBeUndefined();
  expect(
    requestParams({
      ...config,
      liveModel: "claude-haiku-5-5",
      liveSpeed: "fast",
    }).speed,
  ).toBeUndefined();
});

test("refusal fallback is requested on Opus and Sonnet, not on Haiku", async () => {
  expect(requestParams(config)).toMatchObject({
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
  expect(
    requestParams({ ...config, liveModel: "claude-sonnet-5-5" }).fallbacks,
  ).toBe("default");
  const haiku = { ...config, liveModel: "claude-haiku-5-5" };
  expect(requestParams(haiku).fallbacks).toBeUndefined();
  expect(requestParams(haiku).betas).toBeUndefined();
  // Haiku requests go to the standard surface, the others to the beta one.
  const client = fakeClient([{ text: ["Hi."] }]);
  const spy = jest.spyOn(client.messages, "stream");
  await createAgent({ client, config: haiku }).runTurn(history, {
    onText() {},
  });
  expect(spy).toHaveBeenCalledTimes(1);
});

test("prewarm sends one zero-token request with the same prefix and never throws", async () => {
  const client = fakeClient([]);
  await createAgent({ client, config }).prewarm();
  expect(client.created[0]).toMatchObject({
    model: "claude-opus-5-5",
    max_tokens: 0,
    output_config: { effort: "low" },
    system: buildSystem(),
    tools: TOOLS,
  });
  expect(client.created[0].fallbacks).toBeUndefined();
  client.messages.create.mockRejectedValueOnce(new Error("offline"));
  await expect(
    createAgent({ client, config }).prewarm(),
  ).resolves.toBeUndefined();
});

test("a stream that goes quiet after it started speaking is reported as failed", async () => {
  jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
  const client = fakeClient([
    { text: ["Let me explain"], stallAfterText: true },
  ]);
  const seen = [];
  const pending = createAgent({ client, config }).runTurn(history, {
    onText: (t) => seen.push(t),
  });
  await jest.advanceTimersByTimeAsync(5900);
  expect(seen).toEqual(["Let me explain"]);
  await jest.advanceTimersByTimeAsync(200);
  const r = await pending;
  expect(r.failed).toBe(true);
  expect(r.spoken).toBe("Let me explain");
});

test("a tool-only reply that takes seven seconds with events flowing is not a failure", async () => {
  jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
  const client = fakeClient([
    {
      ticks: 7,
      tools: [
        {
          id: "t2",
          name: "end_call",
          input: {
            outcome: "lead",
            callback_promise: "soon",
            goodbye: "Bye now.",
          },
        },
      ],
      stop: "tool_use",
    },
  ]);
  const pending = createAgent({ client, config }).runTurn(history, {
    onText() {},
  });
  await jest.advanceTimersByTimeAsync(7100);
  const r = await pending;
  expect(r.failed).toBe(false);
  expect(r.end).toEqual({ outcome: "lead", callbackPromise: "soon" });
});

test("a request that runs past twenty seconds is failed even with events flowing", async () => {
  jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
  const client = fakeClient([{ ticks: 60, text: ["Eventually."] }]);
  const pending = createAgent({ client, config }).runTurn(history, {
    onText() {},
  });
  await jest.advanceTimersByTimeAsync(20100);
  expect((await pending).failed).toBe(true);
});

test("the latest lookup wins: a later no-match clears an earlier match", async () => {
  const lookup = jest
    .fn()
    .mockResolvedValueOnce({
      found: true,
      legalName: "COMPANY A",
      mc: "196057",
    })
    .mockResolvedValueOnce({ found: false, reason: "no_match" });
  const call = (id, number) => ({
    tools: [{ id, name: "lookup_carrier", input: { number } }],
    stop: "tool_use",
  });
  const client = fakeClient([
    call("t1", "MC 196057"),
    { text: ["I have Company A. Is that you?"] },
    call("t2", "MC 196075"),
    { text: ["Let me read that back."] },
  ]);
  const agent = createAgent({ client, config, lookup });
  const first = await agent.runTurn(history, { onText() {} });
  expect(first).toMatchObject({ lookedUp: "found" });
  expect(first.carrier.legalName).toBe("COMPANY A");
  const second = await agent.runTurn(
    [...first.history, { role: "user", content: "No, that's not me. 196075." }],
    { onText() {} },
  );
  expect(second).toMatchObject({ lookedUp: "no_match", carrier: null });
});

test("a lookup that timed out says nothing about the carrier either way", async () => {
  const lookup = jest
    .fn()
    .mockResolvedValue({ found: false, reason: "timeout" });
  const client = fakeClient([
    {
      tools: [{ id: "t1", name: "lookup_carrier", input: { number: "MC 5" } }],
      stop: "tool_use",
    },
    { text: ["Let me read that back."] },
  ]);
  const r = await createAgent({ client, config, lookup }).runTurn(history, {
    onText() {},
  });
  expect(r.lookedUp).toBeNull();
});

test("a turn with no lookup reports none", async () => {
  const r = await createAgent({
    client: fakeClient([{ text: ["Hi."] }]),
    config,
  }).runTurn(history, { onText() {} });
  expect(r.lookedUp).toBeNull();
});

test("the filler is spoken once when one reply holds two lookups", async () => {
  const lookup = jest
    .fn()
    .mockResolvedValue({ found: false, reason: "no_match" });
  const client = fakeClient([
    {
      tools: [
        { id: "t1", name: "lookup_carrier", input: { number: "MC 5" } },
        { id: "t2", name: "lookup_carrier", input: { number: "USDOT 6" } },
      ],
      stop: "tool_use",
    },
    { text: ["Neither came up."] },
  ]);
  const seen = [];
  await createAgent({ client, config, lookup }).runTurn(history, {
    onText: (t) => seen.push(t),
  });
  expect(seen.filter((t) => t === LOOKUP_FILLER)).toHaveLength(1);
});

test("a goodbye the model already spoke is not said a second time", async () => {
  // Seen in a simulated call: the model wrote its closing words as text and
  // also filled in end_call's goodbye, so the caller heard the promise twice.
  const client = fakeClient([
    {
      text: [
        "A dispatcher will call you back in the next few minutes. Drive safe.",
      ],
      tools: [
        {
          id: "t2",
          name: "end_call",
          input: {
            outcome: "lead",
            callback_promise: "in the next few minutes",
            goodbye:
              "Thanks, Dee, a dispatcher will call you back. Drive safe.",
          },
        },
      ],
      stop: "tool_use",
    },
  ]);
  const seen = [];
  const r = await createAgent({ client, config }).runTurn(history, {
    onText: (t) => seen.push(t),
  });
  expect(seen).toEqual([
    "A dispatcher will call you back in the next few minutes. Drive safe.",
  ]);
  expect(r.spoken).toBe(
    "A dispatcher will call you back in the next few minutes. Drive safe.",
  );
  expect(r.end).toEqual({
    outcome: "lead",
    callbackPromise: "in the next few minutes",
  });
});

test("a goodbye that adds something new after other words is still spoken", async () => {
  const client = fakeClient([
    {
      text: ["Got it, I have Smith Trucking out of Dallas, Texas."],
      tools: [
        {
          id: "t3",
          name: "end_call",
          input: {
            outcome: "lead",
            callback_promise: "in the next few minutes",
            goodbye:
              "A dispatcher will call you back in the next few minutes. Drive safe.",
          },
        },
      ],
      stop: "tool_use",
    },
  ]);
  const r = await createAgent({ client, config }).runTurn(history);
  expect(r.spoken).toBe(
    "Got it, I have Smith Trucking out of Dallas, Texas. A dispatcher will call you back in the next few minutes. Drive safe.",
  );
});

test("the tokens of every request are counted, the pre-warm included", async () => {
  const client = fakeClient(
    [
      {
        tools: [
          { id: "t1", name: "lookup_carrier", input: { number: "MC 196057" } },
        ],
        stop: "tool_use",
        usage: {
          input_tokens: 20,
          output_tokens: 30,
          cache_read_input_tokens: 9000,
        },
      },
      {
        text: ["I couldn't find that number."],
        usage: {
          input_tokens: 60,
          output_tokens: 40,
          cache_read_input_tokens: 9000,
        },
      },
    ],
    {
      prewarmUsage: {
        input_tokens: 4,
        output_tokens: 0,
        cache_creation_input_tokens: 9000,
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: 9000,
        },
      },
    },
  );
  const agent = createAgent({
    client,
    config,
    lookup: async () => ({ found: false, reason: "no_match" }),
  });
  expect(agent.usage()).toEqual([]);
  await agent.prewarm();
  await agent.runTurn(history);
  expect(agent.usage()).toEqual([
    {
      model: "claude-opus-5-5",
      speed: "standard",
      requests: 3,
      input: 84,
      cacheWrite5m: 0,
      cacheWrite1h: 9000,
      cacheRead: 18000,
      output: 70,
    },
  ]);
});

test("a reply the caller cut off still counts the prompt it had read", async () => {
  const client = fakeClient([
    {
      hang: true,
      partialUsage: {
        input_tokens: 15,
        output_tokens: 1,
        cache_read_input_tokens: 9000,
      },
    },
  ]);
  const agent = createAgent({ client, config });
  const controller = new AbortController();
  const turn = agent.runTurn(history, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await turn;
  expect(agent.usage()).toEqual([
    expect.objectContaining({ requests: 1, input: 15, cacheRead: 9000 }),
  ]);
});
