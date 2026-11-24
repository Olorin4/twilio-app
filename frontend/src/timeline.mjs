// Same pattern the timeline API accepts.
const PHONE = /^\+[1-9]\d{7,14}$/;

export const isTimelinePhone = (value) => PHONE.test(String(value || ""));

export function relativeTime(iso, now = Date.now()) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) return "just now";
  const units = [
    ["minute", 60],
    ["hour", 3600],
    ["day", 86400],
    ["week", 604800],
    ["month", 2592000],
    ["year", 31536000],
  ];
  let best = ["minute", 60];
  for (const unit of units) if (seconds >= unit[1]) best = unit;
  const count = Math.max(1, Math.floor(seconds / best[1]));
  const label = `${count} ${best[0]}${count === 1 ? "" : "s"}`;
  return seconds < 0 ? "in the future" : `${label} ago`;
}
