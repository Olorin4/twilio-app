jest.mock("../src/receptionist/config", () => ({
  getConfig: jest.fn(() => ({ hours: {} })),
  isOpen: jest.fn(() => false),
  sayOptions: jest.fn(() => ({})),
}));
const { isOpen } = require("../src/receptionist/config");
const { voiceResponse } = require("../src/callResponse");
const { IRON_WING_WORKSPACE_ID } = require("../src/workspaceContext");

const NUMBER = "+15550001111";
const provider = (extra = {}) => ({
  id: "00000000-0000-4000-8000-000000000009",
  workspaceId: IRON_WING_WORKSPACE_ID,
  phoneNumber: NUMBER,
  legacy: false,
  numberLabel: null,
  observeHours: true,
  ...extra,
});
const OTHER = "00000000-0000-4000-8000-0000000000aa";

beforeEach(() => {
  process.env.TWILIO_WEBHOOK_BASE_URL = "https://example.test";
  isOpen.mockReturnValue(false);
});
afterAll(() => delete process.env.TWILIO_WEBHOOK_BASE_URL);

test("labelled lines pass CalledLabel", () => {
  isOpen.mockReturnValue(true);
  const xml = voiceResponse(
    { To: NUMBER },
    provider({ numberLabel: "Manager" }),
  );
  expect(xml).toContain('<Parameter name="CalledLabel" value="Manager"/>');
});

test("unlabelled lines pass no CalledLabel", () => {
  isOpen.mockReturnValue(true);
  expect(voiceResponse({ To: NUMBER }, provider())).not.toContain(
    "CalledLabel",
  );
});

test("observe_hours off skips the closed message", () => {
  const xml = voiceResponse({ To: NUMBER }, provider({ observeHours: false }));
  expect(xml).not.toContain("/closed");
  expect(xml).toContain("<Client");
});

test("Iron Wing numbers observing hours get the closed message", () => {
  expect(voiceResponse({ To: NUMBER }, provider())).toContain("/closed");
});

test("other workspaces never get the closed message", () => {
  const xml = voiceResponse({ To: NUMBER }, provider({ workspaceId: OTHER }));
  expect(xml).not.toContain("/closed");
  expect(xml).toContain("<Client");
});
