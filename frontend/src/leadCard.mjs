/* Pure helpers for the Leads view: how a call the AI receptionist answered
is worded on its card. Kept free of React so they can be tested directly. */

const E164 = /^\+[1-9]\d{7,14}$/;
const OWED = ["lead", "not_a_lead", "failed"];
const BADGES = {
  lead: "NEW LEAD",
  not_a_lead: "MESSAGE",
  failed: "AGENT FAILED",
  abandoned: "ABANDONED",
  spam: "SPAM",
};

// "ALUM BANK" → "Alum Bank"
const titleCase = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());

// The number the owner can call back on, or null when there is none.
export function callbackTarget(lead) {
  if (E164.test(lead.callbackNumber || "")) return lead.callbackNumber;
  if (E164.test(lead.from || "")) return lead.from;
  return null;
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
