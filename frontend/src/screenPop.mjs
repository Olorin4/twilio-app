import { isTimelinePhone, relativeTime } from "./timeline.mjs";

// The call that is ringing is usually already logged; calls this recent are it.
const RING_WINDOW_MS = 60000;

export const shouldFetch = (number) => isTimelinePhone(number);

// First entry that is not the ringing call itself.
export function latestBefore(entries, ringAt) {
  for (const entry of Array.isArray(entries) ? entries : []) {
    const at = new Date(entry.at).getTime();
    const ringing =
      entry.kind === "call" &&
      Number.isFinite(at) &&
      at >= ringAt - RING_WINDOW_MS;
    if (!ringing) return entry;
  }
  return null;
}

export function popLine(response, ringAt = Date.now(), now = Date.now()) {
  const name = response?.contact?.name || null;
  const entry = latestBefore(response?.entries, ringAt);
  if (!entry) return name;
  const last = `Last: ${entry.summary} · ${relativeTime(entry.at, now)}`;
  return name ? `${name} · ${last}` : last;
}

// A late result is only for the call it was fetched for.
export const isCurrent = (token, current) =>
  Boolean(token) && token === current;
