// What a call cost, for the call history. `row.cost` comes from the server
// only once every part is known: Twilio's charge for the call and its legs
// and, for a call the AI receptionist answered, the ConversationRelay minutes
// and the Claude usage, which are estimates from list prices.

const money = (amount) =>
  "$" + (amount > 0 && amount < 0.1 ? amount.toFixed(3) : amount.toFixed(2));
const amountOf = (value) =>
  value === null || value === undefined || value === "" ? null : Number(value);

// { label, breakdown } for a call, or null when there is nothing to show.
export function callCost(row) {
  const cost = row?.cost;
  if (!cost || cost.unit !== "USD") return null;
  const twilio = amountOf(cost.twilio);
  if (twilio === null || !Number.isFinite(twilio)) return null;
  const parts = ["Twilio call " + money(twilio)];
  let total = twilio;
  let estimated = false;
  for (const [name, value] of [
    ["ConversationRelay", cost.relay],
    ["Claude", cost.claude],
  ]) {
    const amount = amountOf(value);
    if (amount === null || !Number.isFinite(amount)) continue;
    parts.push(name + " ≈ " + money(amount));
    total += amount;
    estimated = true;
  }
  if (estimated) parts.push("≈ marks an estimate from list prices");
  return {
    label: (estimated ? "≈ " : "") + money(total),
    breakdown: parts.join(" · "),
  };
}
