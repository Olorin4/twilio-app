jest.mock("../src/token", () => ({
  callerId: "+15551234567",
  getIdentity: () => "operator",
}));
jest.mock("../src/logManager", () => ({ logMessage: jest.fn() }));

const { voiceResponse } = require("../src/callResponse");
const { smsResponse } = require("../src/smsResponse");
const { logMessage } = require("../src/logManager");

afterEach(() => {
  delete process.env.TWILIO_WEBHOOK_BASE_URL;
  jest.useRealTimers();
  jest.clearAllMocks();
});

test("dialed call legs receive signed-status callback URLs", () => {
  process.env.TWILIO_WEBHOOK_BASE_URL = "https://example.com";
  jest.useFakeTimers().setSystemTime(new Date("2026-01-01T15:00:00Z"));
  const incoming = voiceResponse({ To: "+15551234567" });
  const outgoing = voiceResponse({ To: "+15557654321" });
  for (const twiml of [incoming, outgoing]) {
    expect(twiml).toContain('statusCallback="https://example.com/call-status"');
    expect(twiml).toContain(
      'statusCallbackEvent="initiated ringing answered completed"',
    );
  }
});

test("outgoing calls dial with the configured caller ID outside office hours", () => {
  jest.useFakeTimers().setSystemTime(new Date(2026, 0, 1, 2));
  expect(voiceResponse({ To: "+15557654321" })).toContain(
    '<Dial callerId="+15551234567"><Number>+15557654321</Number></Dial>',
  );
});

test("incoming calls route to the browser during office hours", () => {
  jest.useFakeTimers().setSystemTime(new Date("2026-01-01T15:00:00Z"));
  expect(voiceResponse({ To: "+15551234567" })).toContain(
    "<Client>operator</Client>",
  );
});

test.each([
  ["2026-01-01T11:59:00Z", false],
  ["2026-01-01T12:00:00Z", true],
  ["2026-01-01T22:59:00Z", true],
  ["2026-01-01T23:00:00Z", false],
  ["2026-07-01T10:59:00Z", false],
  ["2026-07-01T11:00:00Z", true],
  ["2026-07-01T21:59:00Z", true],
  ["2026-07-01T22:00:00Z", false],
])("incoming calls at %s observe Eastern business hours", (time, open) => {
  jest.useFakeTimers().setSystemTime(new Date(time));
  const response = voiceResponse({ To: "+15551234567" });
  expect(response.includes("<Client>operator</Client>")).toBe(open);
  expect(response.includes("office is currently closed")).toBe(!open);
});

test("incoming SMS is saved and acknowledged with TwiML", async () => {
  const body = {
    MessageSid: "SM123",
    From: "+15557654321",
    To: "+15551234567",
    Body: "Hello",
  };
  const res = { type: jest.fn(), send: jest.fn(), sendStatus: jest.fn() };
  await smsResponse({ body }, res);
  expect(logMessage).toHaveBeenCalledWith(body);
  expect(res.type).toHaveBeenCalledWith("text/xml");
  expect(res.send).toHaveBeenCalledWith(expect.stringContaining("<Response"));
});

test("incoming SMS reports a storage failure", async () => {
  logMessage.mockRejectedValueOnce(new Error("database unavailable"));
  const res = { sendStatus: jest.fn() };
  await smsResponse({ body: {} }, res);
  expect(res.sendStatus).toHaveBeenCalledWith(500);
});
