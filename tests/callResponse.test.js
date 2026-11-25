// The legacy number and desk identity are read when token.js loads.
const originalCaller = process.env.TWILIO_CALLER_ID;
const originalIdentity = process.env.TWILIO_IDENTITY;
process.env.TWILIO_CALLER_ID = "+15550002222";
process.env.TWILIO_IDENTITY = "iron_wing_desk";
// token.js throws at load without these; use synthetic values so the test
// never depends on (or reads credentials from) a local .env.
for (const [key, value] of Object.entries({
  TWILIO_ACCOUNT_SID: "AC" + "0".repeat(32),
  TWILIO_AUTH_TOKEN: "test-auth-token",
  TWILIO_TWIML_APP_SID: "AP" + "0".repeat(32),
  TWILIO_API_KEY: "SK" + "0".repeat(32),
  TWILIO_API_SECRET: "test-api-secret",
}))
  process.env[key] = value;
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
afterAll(() => {
  delete process.env.TWILIO_WEBHOOK_BASE_URL;
  if (originalCaller === undefined) delete process.env.TWILIO_CALLER_ID;
  else process.env.TWILIO_CALLER_ID = originalCaller;
  if (originalIdentity === undefined) delete process.env.TWILIO_IDENTITY;
  else process.env.TWILIO_IDENTITY = originalIdentity;
});

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

const ALICE = "u" + "a".repeat(32) + "_c00000000000040008000000000000009";
const BOB = "u" + "b".repeat(32) + "_c00000000000040008000000000000009";

test("one Client per identity, each with the parameters", () => {
  isOpen.mockReturnValue(true);
  const xml = voiceResponse(
    { To: NUMBER },
    provider({ numberLabel: "Manager" }),
    [ALICE, BOB],
  );
  const clients = xml.match(/<Client[^>]*>.*?<\/Client>/g);
  expect(clients).toHaveLength(2);
  [ALICE, BOB].forEach((identity, index) => {
    const client = clients[index];
    expect(client).toContain(`<Identity>${identity}</Identity>`);
    expect(client).toContain(
      'statusCallback="https://example.test/webhooks/00000000-0000-4000-8000-000000000009/call-status"',
    );
    expect(client).toContain(
      'statusCallbackEvent="initiated ringing answered completed"',
    );
    expect(client).toContain(
      `<Parameter name="CalledNumber" value="${NUMBER}"/>`,
    );
    expect(client).toContain('<Parameter name="CalledLabel" value="Manager"/>');
  });
  // One Dial, so whoever answers first takes the call.
  expect(xml.match(/<Dial/g)).toHaveLength(1);
});

test("an empty ring list still rings today's identity", () => {
  isOpen.mockReturnValue(true);
  for (const list of [[], undefined, null])
    expect(voiceResponse({ To: NUMBER }, provider(), list)).toContain(
      "<Identity>connection_00000000000040008000000000000009</Identity>",
    );
});

// Generated from master (b8aff4d) voiceResponse({ To, From }) with
// TWILIO_WEBHOOK_BASE_URL=https://example.test, TWILIO_CALLER_ID=+15550002222
// and TWILIO_IDENTITY=iron_wing_desk, inside business hours.
const MASTER_LEGACY_DIAL =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="20" action="https://example.test/announcement/missed"><Client statusCallback="https://example.test/call-status" statusCallbackEvent="initiated ringing answered completed" statusCallbackMethod="POST">iron_wing_desk</Client></Dial></Response>';
// The same with no TWILIO_WEBHOOK_BASE_URL.
const MASTER_LEGACY_DIAL_NO_BASE =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="20"><Client>iron_wing_desk</Client></Dial><Say>Hello! Thank you for calling Iron Wing Dispatching. One of our representatives will call you back soon.</Say></Response>';

test("legacy dial with one bootstrap identity is byte-identical to today", () => {
  isOpen.mockReturnValue(true);
  const body = { To: "+15550002222", From: "+15557778888" };
  expect(voiceResponse(body, undefined, ["iron_wing_desk"])).toBe(
    MASTER_LEGACY_DIAL,
  );
  expect(voiceResponse(body)).toBe(MASTER_LEGACY_DIAL);
  delete process.env.TWILIO_WEBHOOK_BASE_URL;
  expect(voiceResponse(body, undefined, ["iron_wing_desk"])).toBe(
    MASTER_LEGACY_DIAL_NO_BASE,
  );
});

test("the legacy line dials every owner in one Dial", () => {
  isOpen.mockReturnValue(true);
  const owners = [
    "u" + "a".repeat(32) + "_legacy",
    "u" + "b".repeat(32) + "_legacy",
  ];
  const xml = voiceResponse({ To: "+15550002222" }, undefined, owners);
  expect(xml).toBe(
    '<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="20" action="https://example.test/announcement/missed">' +
      owners
        .map(
          (identity) =>
            `<Client statusCallback="https://example.test/call-status" statusCallbackEvent="initiated ringing answered completed" statusCallbackMethod="POST">${identity}</Client>`,
        )
        .join("") +
      "</Dial></Response>",
  );
});
