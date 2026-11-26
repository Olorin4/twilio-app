const OFFER = "black-friday-2026";
const ENROLLMENT_END = Date.parse("2026-12-01T00:00:00-06:00");

function usesIronWingOffer(profile) {
  return (
    profile?.kind === "receptionist" &&
    profile.companyName === "Iron Wing Dispatching" &&
    profile.knowledge?.includes("<!-- iron-wing-dispatch-offer-v1 -->")
  );
}

function enrollmentOpen(now, env = process.env) {
  const opensAt = Date.parse(env.IWD_BLACK_FRIDAY_OPENS_AT);
  return (
    env.IWD_BLACK_FRIDAY_ENABLED === "1" &&
    Number.isFinite(opensAt) &&
    +now >= opensAt &&
    +now < ENROLLMENT_END
  );
}

function closedForHoliday(now, timeZone, env = process.env) {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return (env.IWD_DISPATCH_CLOSED_DATES || "")
    .split(",")
    .some((date) => date.trim() === day);
}

module.exports = { OFFER, usesIronWingOffer, enrollmentOpen, closedForHoliday };
