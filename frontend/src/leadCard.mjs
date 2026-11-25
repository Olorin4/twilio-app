/* Pure helpers for the Leads view: how a call the AI receptionist answered
is worded on its card. Kept free of React so they can be tested directly. */

const E164 = /^\+[1-9]\d{7,14}$/;
// Pseudo-numbers Twilio sends for a withheld caller ID. Mirrors
// src/receptionist/phone.js.
const WITHHELD = [
  "+266696687",
  "+7378742833",
  "+2562533",
  "+8656696",
  "+86282452253",
];
const callable = (value) =>
  E164.test(value || "") && !WITHHELD.includes(value) ? value : null;
export const OWED = [
  "lead",
  "not_a_lead",
  "message",
  "urgent",
  "support_request",
  "prospect",
  "failed",
];
const BADGES = {
  lead: "NEW LEAD",
  not_a_lead: "MESSAGE",
  failed: "AGENT FAILED",
  abandoned: "ABANDONED",
  message: "MESSAGE",
  urgent: "URGENT",
  support_request: "SUPPORT",
  not_support: "NOT SUPPORT",
  prospect: "PROSPECT",
  spam: "SPAM",
};

// "ALUM BANK" → "Alum Bank"
const titleCase = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());

// The number the owner can call back on, or null when there is none.
export function callbackTarget(lead) {
  return callable(lead.callbackNumber) || callable(lead.from);
}

// The number whose history the card opens: the caller who rang, and the
// callback number they gave only when the caller was anonymous.
export function historyTarget(lead) {
  return callable(lead.from) || callable(lead.callbackNumber);
}

// The number given on the call came through speech recognition and may be
// wrong, so the number they actually called from is shown beside it.
export function callerIdNote(lead) {
  const from = callable(lead.from);
  return from && callable(lead.callbackNumber) && from !== lead.callbackNumber
    ? `Called from ${from}`
    : null;
}

export function leadTitle(lead) {
  const named = [lead.callerName, lead.company].filter(Boolean).join(" · ");
  return named || callbackTarget(lead) || "Unknown caller";
}

export function carrierLine(lead) {
  const number = lead.mcNumber
    ? `MC ${lead.mcNumber}`
    : lead.usdot
      ? `USDOT ${lead.usdot}`
      : null;
  if (!number) return "No authority yet";
  if (!lead.mcVerified) return `${number} (not verified)`;
  const carrier = lead.carrier || {};
  const place = [titleCase(carrier.city), carrier.state]
    .filter(Boolean)
    .join(", ");
  const trucks = Number.isInteger(carrier.powerUnits)
    ? `${carrier.powerUnits} ${carrier.powerUnits === 1 ? "truck" : "trucks"}`
    : "";
  const since = carrier.since ? `USDOT since ${carrier.since}` : "";
  return [`${number} ✓ verified`, place, trucks, since]
    .filter(Boolean)
    .join(" · ");
}

export function badge(lead) {
  return BADGES[lead.outcome] || "CALL";
}

export function promiseLine(lead) {
  return lead.callbackPromise
    ? `Promised: ${lead.callbackPromise}`
    : "No callback time promised";
}

// True for a card that still needs the owner's attention.
export function unread(lead) {
  return lead.status === "new" && OWED.includes(lead.outcome);
}
