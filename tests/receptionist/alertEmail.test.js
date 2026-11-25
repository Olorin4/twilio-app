const { getConfig } = require("../../src/receptionist/config");
const { sendCallEmail } = require("../../src/receptionist/alertEmail");
const { JACK } = require("../../src/receptionist/seed/jack");

// Jack's profile, as Iron Wing's calls send it.
const sendJack = (row, cfg, options) => sendCallEmail(row, cfg, JACK, options);

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
  expect(await sendJack(row, config, { transport })).toBe(true);
  const mail = transport.sendMail.mock.calls[0][0];
  // The sender name is the agent's company; the address is SMTP_FROM's.
  expect(mail.from).toBe('"Iron Wing Dispatching" <alerts@example.test>');
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
  await sendJack(
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
  await sendJack({ ...row, outcome: "failed" }, config, { transport });
  expect(transport.sendMail.mock.calls[0][0].subject).toBe(
    "Agent failed, call back: Mike Alvarez — Alvarez Hauling LLC",
  );
});

test("a caller with no number at all says so", async () => {
  await sendJack(
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
  await sendJack(
    { ...row, caller_name: "Mike\r\nBcc: evil@example.test" },
    config,
    { transport },
  );
  expect(transport.sendMail.mock.calls[0][0].subject).not.toMatch(/[\r\n]/);
});

test("returns false and sends nothing when alerts or SMTP are not configured", async () => {
  expect(await sendJack(row, getConfig({}), { transport })).toBe(false);
  expect(
    await sendJack(
      row,
      getConfig({ RECEPTIONIST_ALERT_EMAIL: "owner@example.test" }),
      { transport },
    ),
  ).toBe(false);
  expect(transport.sendMail).not.toHaveBeenCalled();
});

test("a send failure is reported as false, not thrown", async () => {
  transport.sendMail.mockRejectedValue(new Error("smtp down"));
  expect(await sendJack(row, config, { transport })).toBe(false);
});

test("a withheld caller ID delivered as a pseudo-number is not offered as a callback", async () => {
  await sendJack(
    { from_number: "+266696687", outcome: "lead", summary: "x" },
    config,
    { transport },
  );
  const mail = transport.sendMail.mock.calls[0][0];
  expect(mail.text).toContain("Call back: no number given");
  expect(mail.subject).toBe("New lead: unknown caller — unknown company");
});

test("the caller ID is listed beside a different number the caller gave", async () => {
  await sendJack({ ...row, callback_number: "+15557778888" }, config, {
    transport,
  });
  const text = transport.sendMail.mock.calls[0][0].text;
  expect(text).toContain("Call back: +15557778888");
  expect(text).toContain("Called from: +15551230009");
});

test("with no summary the email carries the transcript, so it can stand alone", async () => {
  await sendJack(
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

describe("emails per agent profile", () => {
  const ava = {
    id: "00000000-0000-4000-8000-0000000000b1",
    workspaceId: "00000000-0000-4000-8000-000000000002",
    kind: "support",
    personaName: "Ava",
    companyName: "KelevoTMS",
    alertEmail: "support-alerts@example.test",
  };
  const dispatcher = {
    ...ava,
    kind: "dispatcher",
    personaName: "Sam",
    companyName: "Northline Dispatch",
    alertEmail: null,
  };
  const message = {
    call_sid: row.call_sid,
    from_number: "+15551230009",
    outcome: "support_request",
    caller_name: "Dana Lee",
    company: "Lee Freight",
    mc_verified: false,
    summary: "Cannot log in.",
    script: null,
    details: null,
    transcript: [
      { role: "agent", text: "Thanks for calling." },
      { role: "caller", text: "I can't log in." },
    ],
  };
  const sent = () => transport.sendMail.mock.calls[0][0];

  test("urgent subjects start with URGENT", async () => {
    await sendCallEmail({ ...message, outcome: "urgent" }, config, dispatcher, {
      transport,
    });
    expect(sent().subject).toBe("URGENT: Dana Lee — Lee Freight");
  });

  test.each([
    ["message", "Message: Dana Lee — Lee Freight"],
    ["support_request", "Support request: Dana Lee — Lee Freight"],
    ["prospect", "Sales prospect: Dana Lee — Lee Freight"],
  ])("a %s is labelled for what it is", async (outcome, subject) => {
    await sendCallEmail({ ...message, outcome }, config, ava, { transport });
    expect(sent().subject).toBe(subject);
  });

  test("the recipient is the profile's alert email, else the global one", async () => {
    await sendCallEmail(message, config, ava, { transport });
    expect(sent().to).toBe("support-alerts@example.test");
    transport.sendMail.mockClear();
    await sendCallEmail(message, config, dispatcher, { transport });
    expect(sent().to).toBe("owner@example.test");
    transport.sendMail.mockClear();
    // Jack has no alert email of his own.
    await sendJack(message, config, { transport });
    expect(sent().to).toBe("owner@example.test");
  });

  test("a profile's own alert email works without the global one", async () => {
    const noGlobal = getConfig({
      SMTP_HOST: "smtp.example.test",
      SMTP_FROM: "Alerts <alerts@example.test>",
    });
    expect(await sendCallEmail(message, noGlobal, ava, { transport })).toBe(
      true,
    );
    expect(sent().to).toBe("support-alerts@example.test");
  });

  test("transcript lines use the persona name", async () => {
    await sendCallEmail(message, config, ava, { transport });
    expect(sent().text).toContain("Ava: Thanks for calling.");
    expect(sent().text).toContain("Caller: I can't log in.");
    expect(sent().text).not.toMatch(/Jack/);
  });

  test("a support email carries no trucking lines", async () => {
    await sendCallEmail(message, config, ava, { transport });
    expect(sent().text).not.toMatch(/authority|MC |USDOT/i);
  });

  test("without a profile the email is minimal and names no persona", async () => {
    await sendCallEmail(message, config, null, { transport });
    expect(sent().to).toBe("owner@example.test");
    expect(sent().subject).toMatch(/^Agent call/);
    expect(sent().text).toContain("Agent: Thanks for calling.");
    expect(sent().text).not.toMatch(/Jack|Ava|Iron Wing/);
    transport.sendMail.mockClear();
    await sendCallEmail({ ...message, outcome: "failed" }, config, null, {
      transport,
    });
    expect(sent().subject).toMatch(/^Agent call/);
  });

  test("lead emails keep today's layout for receptionists", async () => {
    await sendJack(
      {
        ...row,
        callback_number: "+15557778888",
        transcript: [{ role: "caller", text: "hi" }],
      },
      config,
      { transport },
    );
    expect(sent().subject).toBe("New lead: Mike Alvarez — Alvarez Hauling LLC");
    expect(sent().text).toBe(
      [
        "Caller: Mike Alvarez",
        "Company: Alvarez Hauling LLC",
        "MC 1234567 (verified) · USDOT 7654321",
        "Call back: +15557778888",
        "Called from: +15551230009",
        "Promised: in the next few minutes",
        "",
        "SUMMARY",
        "Owner-operator with two dry vans.",
        "",
        "SUGGESTED SCRIPT",
        "Open: Mike, this is Iron Wing.",
        "- 5% Essential plan",
        "- fee: 5% of linehaul",
        "Ask for: Sign up today",
        "",
        "COULDN'T ANSWER ON THE CALL",
        "- Factoring paperwork",
        "",
        "Open the softphone: https://phone.example.test/",
      ].join("\n"),
    );
    transport.sendMail.mockClear();
    await sendJack(
      {
        ...row,
        outcome: "failed",
        script: null,
        details: null,
        transcript: message.transcript,
      },
      config,
      { transport },
    );
    expect(sent().text).toBe(
      [
        "Caller: Mike Alvarez",
        "Company: Alvarez Hauling LLC",
        "MC 1234567 (verified) · USDOT 7654321",
        "Call back: +15551230009",
        "Promised: in the next few minutes",
        "",
        "SUMMARY",
        "Owner-operator with two dry vans.",
        "",
        "TRANSCRIPT",
        "Jack: Thanks for calling.",
        "Caller: I can't log in.",
        "",
        "Open the softphone: https://phone.example.test/",
      ].join("\n"),
    );
  });
});

describe("the sender name is the agent's company", () => {
  const kelevo = { ...JACK, kind: "support", companyName: "KelevoTMS" };
  const send = (profile, cfg = config) =>
    sendCallEmail({ ...row, outcome: "support_request" }, cfg, profile, {
      transport,
    });
  const from = () => transport.sendMail.mock.calls[0][0].from;

  test("uses the profile's company with the SMTP_FROM address", async () => {
    await send(kelevo);
    expect(from()).toBe('"KelevoTMS" <alerts@example.test>');
  });
  test("works when SMTP_FROM is a bare address", async () => {
    const bare = getConfig({
      RECEPTIONIST_ALERT_EMAIL: "owner@example.test",
      SMTP_HOST: "smtp.example.test",
      SMTP_FROM: "alerts@example.test",
    });
    await send(kelevo, bare);
    expect(from()).toBe('"KelevoTMS" <alerts@example.test>');
  });
  test("Jack's emails come from Iron Wing Dispatching", async () => {
    await sendJack(row, config, { transport });
    expect(from()).toBe('"Iron Wing Dispatching" <alerts@example.test>');
  });
  test("with no profile the configured sender is used unchanged", async () => {
    await sendCallEmail({ ...row, outcome: "failed" }, config, null, {
      transport,
    });
    expect(from()).toBe("Iron Wing Leads <alerts@example.test>");
  });
  test("quotes and line breaks in a company name cannot forge headers", async () => {
    await send({ ...kelevo, companyName: 'Evil"\r\nBcc: x@y.z' });
    expect(from()).toBe('"Evil Bcc: x@y.z" <alerts@example.test>');
  });
});
