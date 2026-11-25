/* The email that tells the owner a caller is waiting for a callback, so the
alert reaches them when the softphone tab is closed. Plain text only.

It goes to the agent profile's alert address, else RECEPTIONIST_ALERT_EMAIL.
A receptionist's (Jack's) lead email keeps the layout it had before agent
profiles; a dispatcher's or support line's is a message with a to-do. With no
profile (it could not be loaded) the email is minimal and names no agent. */

const nodemailer = require("nodemailer");
const { callableNumber } = require("./phone");

const LABELS = {
  lead: "New lead",
  not_a_lead: "Message",
  message: "Message",
  urgent: "URGENT",
  support_request: "Support request",
  prospect: "Sales prospect",
  failed: "Agent failed, call back",
};

function subjectLabel(outcome, profile) {
  if (!profile)
    return outcome === "failed" ? "Agent call failed, call back" : "Agent call";
  return (
    LABELS[outcome] ||
    (profile.kind === "receptionist" ? "New lead" : "Agent call")
  );
}
// Caller-supplied text goes into the subject line; keep it to one line.
const oneLine = (value) =>
  String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .trim();

const callbackNumber = (row) =>
  callableNumber(row.callback_number) || callableNumber(row.from_number);

function authorityLine(row) {
  const parts = [];
  if (row.mc_number)
    parts.push(
      `MC ${row.mc_number} (${row.mc_verified ? "verified" : "not verified"})`,
    );
  if (row.usdot) parts.push(`USDOT ${row.usdot}`);
  return parts.length ? parts.join(" · ") : "No authority yet";
}

function body(row, profile) {
  const lead = profile?.kind === "receptionist";
  const persona = profile?.personaName || "Agent";
  const number = callbackNumber(row);
  const script = row.script || {};
  const details = row.details || {};
  // A lead always says where its authority stands; other calls mention one
  // only when the caller gave it, and a support line never does.
  const authority =
    lead || (profile?.kind !== "support" && (row.mc_number || row.usdot))
      ? [authorityLine(row)]
      : [];
  const lines = [
    `Caller: ${oneLine(row.caller_name) || "unknown"}`,
    `Company: ${oneLine(row.company) || "unknown"}`,
    ...authority,
    `Call back: ${number || "no number given"}`,
    // A number given on the call came through speech recognition and may be
    // wrong; the number they called from is the check.
    ...(callableNumber(row.from_number) && row.from_number !== number
      ? [`Called from: ${row.from_number}`]
      : []),
    `Promised: ${oneLine(row.callback_promise) || "no time promised"}`,
    "",
    "SUMMARY",
    row.summary || "No summary was written for this call.",
  ];
  // Without a script, the transcript is what the owner has to go on.
  const turns = Array.isArray(row.transcript) ? row.transcript : [];
  if (!row.script && turns.length) {
    lines.push("", "TRANSCRIPT");
    for (const turn of turns.slice(-60))
      lines.push(
        `${turn.role === "caller" ? "Caller" : persona}: ${turn.text}`,
      );
  }
  if (script.opener || script.points?.length || script.next_step) {
    lines.push("", lead ? "SUGGESTED SCRIPT" : "TO DO");
    if (script.opener) lines.push(`Open: ${script.opener}`);
    for (const point of script.points || []) lines.push(`- ${point}`);
    for (const item of script.objections || [])
      lines.push(`- ${item.objection}: ${item.answer}`);
    if (script.next_step)
      lines.push(
        `${lead ? "Ask for" : "Before hanging up"}: ${script.next_step}`,
      );
  }
  if (details.unanswered?.length) {
    lines.push("", "COULDN'T ANSWER ON THE CALL");
    for (const question of details.unanswered) lines.push(`- ${question}`);
  }
  const softphone = process.env.TWILIO_WEBHOOK_BASE_URL;
  if (softphone)
    lines.push("", `Open the softphone: ${softphone.replace(/\/?$/, "/")}`);
  return lines.join("\n");
}

// The From header: the agent's company as the display name, with the
// configured sender's address (SMTP_FROM may be "Name <address>" or a bare
// address). Quotes and line breaks are removed so a company name cannot forge
// headers. Without a profile the configured sender is used unchanged.
function senderFor(config, profile, fallback) {
  const configured = config.smtp.from || config.smtp.user || fallback;
  const company = String(profile?.companyName || "")
    .replace(/["\\\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!company) return configured;
  const address = (/<([^>]+)>/.exec(configured) || [])[1] || configured;
  return `"${company}" <${address.trim()}>`;
}

// Resolves true when the email was handed to the mail server. Never throws.
// `profile` is the call's agent profile, or null when it could not be loaded.
async function sendCallEmail(row, config, profile, { transport } = {}) {
  const to = profile?.alertEmail || config.alertEmail;
  if (!to || !config.smtp.host) return false;
  try {
    const mailer =
      transport ||
      nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.port === 465,
        ...(config.smtp.user
          ? { auth: { user: config.smtp.user, pass: config.smtp.pass } }
          : {}),
      });
    const who =
      oneLine(row.caller_name) || callbackNumber(row) || "unknown caller";
    await mailer.sendMail({
      from: senderFor(config, profile, to),
      to,
      subject: `${subjectLabel(row.outcome, profile)}: ${who} — ${oneLine(row.company) || "unknown company"}`,
      text: body(row, profile),
    });
    return true;
  } catch (error) {
    console.error("Call email failed:", error.code || error.message);
    return false;
  }
}

module.exports = { sendCallEmail };
