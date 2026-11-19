const mockParse = jest.fn();
jest.mock("@anthropic-ai/sdk", () => ({
  default: jest.fn(() => ({ messages: { parse: mockParse } })),
}));
const { analyze } = require("../src/callAssist/model");

beforeEach(() => {
  mockParse.mockReset();
  mockParse.mockResolvedValue({
    stop_reason: "end_turn",
    parsed_output: { line: "When should I call back?" },
    usage: { input_tokens: 20, output_tokens: 5 },
  });
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
    const [request] = mockParse.mock.calls[0];
    expect(request).not.toHaveProperty("thinking");
    expect(request.max_tokens).toBe(maxTokens);
    expect(request.output_config.effort).toBe(effort);
    expect(request.output_config.format.type).toBe("json_schema");
    expect(result).toMatchObject({ input: 20, tokens: 5 });
  },
);
