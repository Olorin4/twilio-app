/* The email that tells the owner a lead is waiting for a callback, so the
alert reaches them when the softphone tab is closed. Plain text only. */

const nodemailer = require("nodemailer");

const E164 = /^\+[1-9]\d{7,14}$/;
const LABELS = {
  not_a_lead: "Message",
  failed: "Agent failed, call back",
};
// Caller-supplied text goes into the subject line; keep it to one line.
const oneLine = (value) =>
  String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .trim();

function callbackNumber(row) {
  if (E164.test(row.callback_number || "")) return row.callback_number;
  if (E164.test(row.from_number || "")) return row.from_number;
  return null;
}

function authorityLine(row) {
  const parts = [];
  if (row.mc_number)
    parts.push(
      `MC ${row.mc_number} (${row.mc_verified ? "verified" : "not verified"})`,
    );
  if (row.usdot) parts.push(`USDOT ${row.usdot}`);
  return parts.length ? parts.join(" · ") : "No authority yet";
}

function body(row) {
  const number = callbackNumber(row);
  const script = row.script || {};
  const details = row.details || {};
  const lines = [
    `Caller: ${oneLine(row.caller_name) || "unknown"}`,
    `Company: ${oneLine(row.company) || "unknown"}`,
    authorityLine(row),
    `Call back: ${number || "no number given"}`,
    `Promised: ${oneLine(row.callback_promise) || "no time promised"}`,
    "",
    "SUMMARY",
    row.summary || "No summary.",
  ];
  if (script.opener || script.points?.length || script.next_step) {
    lines.push("", "SUGGESTED SCRIPT");
    if (script.opener) lines.push(`Open: ${script.opener}`);
    for (const point of script.points || []) lines.push(`- ${point}`);
    for (const item of script.objections || [])
      lines.push(`- ${item.objection}: ${item.answer}`);
    if (script.next_step) lines.push(`Ask for: ${script.next_step}`);
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

// Resolves true when the email was handed to the mail server. Never throws.
async function sendLeadEmail(row, config, { transport } = {}) {
  if (!config.alertEmail || !config.smtp.host) return false;
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
      from: config.smtp.from || config.smtp.user || config.alertEmail,
      to: config.alertEmail,
      subject: `${LABELS[row.outcome] || "New lead"}: ${who} — ${oneLine(row.company) || "unknown company"}`,
      text: body(row),
    });
    return true;
  } catch (error) {
    console.error("Lead email failed:", error.code || error.message);
    return false;
  }
}

module.exports = { sendLeadEmail };
