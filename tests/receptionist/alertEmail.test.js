const { getConfig } = require("../../src/receptionist/config");
const { sendLeadEmail } = require("../../src/receptionist/alertEmail");

const config = getConfig({
  RECEPTIONIST_ALERT_EMAIL: "owner@example.test",
  SMTP_HOST: "smtp.example.test",
  SMTP_USER: "alerts@example.test",
  SMTP_PASS: "secret",
  SMTP_FROM: "Iron Wing Leads <alerts@example.test>",
});
const row = {
  call_sid: `CA${"1".repeat(32)}`,
  from_number: "+15551230009",
  outcome: "lead",
  caller_name: "Mike Alvarez",
  company: "Alvarez Hauling LLC",
  mc_number: "1234567",
  usdot: "7654321",
  mc_verified: true,
  callback_number: null,
  callback_promise: "in the next few minutes",
  details: { unanswered: ["Factoring paperwork"], interest: "high" },
  summary: "Owner-operator with two dry vans.",
  script: {
    opener: "Mike, this is Iron Wing.",
    points: ["5% Essential plan"],
    objections: [{ objection: "fee", answer: "5% of linehaul" }],
    next_step: "Sign up today",
  },
};
let transport;

beforeEach(() => {
  transport = { sendMail: jest.fn().mockResolvedValue({}) };
  process.env.TWILIO_WEBHOOK_BASE_URL = "https://phone.example.test/";
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.TWILIO_WEBHOOK_BASE_URL;
  jest.restoreAllMocks();
});

test("the email names the caller, the MC check and the promise", async () => {
  expect(await sendLeadEmail(row, config, { transport })).toBe(true);
  const mail = transport.sendMail.mock.calls[0][0];
  expect(mail.from).toBe("Iron Wing Leads <alerts@example.test>");
  expect(mail.to).toBe("owner@example.test");
  expect(mail.subject).toBe("New lead: Mike Alvarez — Alvarez Hauling LLC");
  expect(mail.text).toMatch(/MC 1234567 \(verified\)/);
  expect(mail.text).toContain("USDOT 7654321");
  expect(mail.text).toContain("in the next few minutes");
  expect(mail.text).toContain("Call back: +15551230009");
  expect(mail.text).toContain("Owner-operator with two dry vans.");
  expect(mail.text).toContain("Mike, this is Iron Wing.");
  expect(mail.text).toContain("fee: 5% of linehaul");
  expect(mail.text).toContain("Factoring paperwork");
  expect(mail.text).toContain("https://phone.example.test/");
  expect(mail.html).toBeUndefined();
});

test("a message from a non-lead is labelled as a message, with sparse fields handled", async () => {
  await sendLeadEmail(
    {
      call_sid: row.call_sid,
      from_number: "anonymous",
      outcome: "not_a_lead",
      mc_verified: false,
      mc_number: "55",
      callback_number: "+15557778888",
      summary: "Broker asking about a load.",
    },
    config,
    { transport },
  );
  const mail = transport.sendMail.mock.calls[0][0];
  expect(mail.subject).toBe("Message: +15557778888 — unknown company");
  expect(mail.text).toMatch(/MC 55 \(not verified\)/);
  expect(mail.text).toContain("Call back: +15557778888");
  expect(mail.text).not.toContain("undefined");
  expect(mail.text).not.toContain("null");
});

test("a call the agent failed on is labelled so the owner calls back", async () => {
  await sendLeadEmail({ ...row, outcome: "failed" }, config, { transport });
  expect(transport.sendMail.mock.calls[0][0].subject).toBe(
    "Agent failed, call back: Mike Alvarez — Alvarez Hauling LLC",
  );
});

test("a caller with no number at all says so", async () => {
  await sendLeadEmail(
    { from_number: "anonymous", outcome: "lead", summary: "x" },
    config,
    { transport },
  );
  const mail = transport.sendMail.mock.calls[0][0];
  expect(mail.subject).toBe("New lead: unknown caller — unknown company");
  expect(mail.text).toContain("Call back: no number given");
  expect(mail.text).toContain("No authority yet");
});

test("line breaks in caller-supplied text cannot forge mail headers", async () => {
  await sendLeadEmail(
    { ...row, caller_name: "Mike\r\nBcc: evil@example.test" },
    config,
    { transport },
  );
  expect(transport.sendMail.mock.calls[0][0].subject).not.toMatch(/[\r\n]/);
});

test("returns false and sends nothing when alerts or SMTP are not configured", async () => {
  expect(await sendLeadEmail(row, getConfig({}), { transport })).toBe(false);
  expect(
    await sendLeadEmail(
      row,
      getConfig({ RECEPTIONIST_ALERT_EMAIL: "owner@example.test" }),
      { transport },
    ),
  ).toBe(false);
  expect(transport.sendMail).not.toHaveBeenCalled();
});

test("a send failure is reported as false, not thrown", async () => {
  transport.sendMail.mockRejectedValue(new Error("smtp down"));
  expect(await sendLeadEmail(row, config, { transport })).toBe(false);
});

test("a withheld caller ID delivered as a pseudo-number is not offered as a callback", async () => {
  await sendLeadEmail(
    { from_number: "+266696687", outcome: "lead", summary: "x" },
    config,
    { transport },
  );
  const mail = transport.sendMail.mock.calls[0][0];
  expect(mail.text).toContain("Call back: no number given");
  expect(mail.subject).toBe("New lead: unknown caller — unknown company");
});

test("the caller ID is listed beside a different number the caller gave", async () => {
  await sendLeadEmail({ ...row, callback_number: "+15557778888" }, config, {
    transport,
  });
  const text = transport.sendMail.mock.calls[0][0].text;
  expect(text).toContain("Call back: +15557778888");
  expect(text).toContain("Called from: +15551230009");
});

test("with no summary the email carries the transcript, so it can stand alone", async () => {
  await sendLeadEmail(
    {
      ...row,
      outcome: "failed",
      summary: null,
      script: null,
      details: null,
      transcript: [
        { role: "agent", text: "Thanks for calling." },
        { role: "caller", text: "My number is 555 123 0009" },
      ],
    },
    config,
    { transport },
  );
  const text = transport.sendMail.mock.calls[0][0].text;
  expect(text).toContain("TRANSCRIPT");
  expect(text).toContain("Jack: Thanks for calling.");
  expect(text).toContain("Caller: My number is 555 123 0009");
});
