const mockParse = jest.fn();
const mockStream = jest.fn();
jest.mock("@anthropic-ai/sdk", () => ({
  default: jest.fn(() => ({
    messages: { parse: mockParse, stream: mockStream },
  })),
}));
const { analyze } = require("../src/callAssist/model");

const reply = {
  stop_reason: "end_turn",
  parsed_output: { line: "When should I call back?" },
  usage: { input_tokens: 20, output_tokens: 5 },
};

beforeEach(() => {
  mockParse.mockReset().mockResolvedValue(reply);
  mockStream.mockReset().mockImplementation(() => ({
    async *[Symbol.asyncIterator]() {},
    finalMessage: async () => reply,
  }));
});

test.each([
  ["suggestion", 1200, "low"],
  ["summary", 3000, undefined],
])(
  "supports Opus 5.5 adaptive thinking for %s",
  async (kind, maxTokens, effort) => {
    const result = await analyze({
      model: "claude-opus-5-5",
      kind,
      transcript: [{ speaker: "Caller", content: "I need a callback." }],
    });
    const [request] = (kind === "summary" ? mockParse : mockStream).mock
      .calls[0];
    expect(request).not.toHaveProperty("thinking");
    expect(request.max_tokens).toBe(maxTokens);
    expect(request.output_config.effort).toBe(effort);
    expect(request.output_config.format.type).toBe("json_schema");
    expect(result).toMatchObject({ input: 20, tokens: 5 });
  },
);

test("uses Haiku without thinking for a short live suggestion", async () => {
  await analyze({
    model: "claude-haiku-5-5",
    kind: "suggestion",
    transcript: [{ speaker: "Caller", content: "What time is pickup?" }],
  });
  expect(mockStream).toHaveBeenCalledWith(
    expect.objectContaining({
      thinking: { type: "disabled" },
      max_tokens: 350,
      output_config: expect.objectContaining({ effort: "low" }),
    }),
    expect.anything(),
  );
});

test("delivers the first complete cue before the rest of the structured response", async () => {
  const cue = jest.fn();
  const fragment = (text) => ({
    type: "content_block_delta",
    delta: { type: "text_delta", text },
  });
  mockStream.mockReturnValueOnce({
    async *[Symbol.asyncIterator]() {
      yield fragment('{"line":"Can you confirm the \\"');
      expect(cue).not.toHaveBeenCalled();
      yield fragment('pickup window\\"?"');
      expect(cue).toHaveBeenCalledWith('Can you confirm the "pickup window"?');
      yield fragment(',"hint":"Check the schedule"}');
    },
    finalMessage: async () => ({
      ...reply,
      parsed_output: {
        line: 'Can you confirm the "pickup window"?',
        hint: "Check the schedule",
      },
    }),
  });
  const result = await analyze({
    kind: "suggestion",
    model: "claude-haiku-5-5",
    onCue: cue,
  });
  expect(cue).toHaveBeenCalledTimes(1);
  expect(result.output.hint).toBe("Check the schedule");
});
