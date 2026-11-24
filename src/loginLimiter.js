/* Counts failed logins per key (a client address, a username) over a rolling
window. A key with `max` failures in the last `windowMs` is blocked until the
oldest of them rolls off. Memory is bounded: past `maxKeys` the key touched
longest ago is dropped, and a key whose failures have all rolled off is
deleted when next seen. In memory only, so it resets on restart and is per
process. */

function createLoginLimiter({
  max = 10,
  windowMs = 60 * 1000,
  maxKeys = 10000,
} = {}) {
  // key -> timestamps of recent failures, oldest first (at most `max`).
  const failures = new Map();

  const recent = (key, now) => {
    const times = failures.get(key);
    if (!times) return [];
    const kept = times.filter((at) => now - at < windowMs);
    if (!kept.length) failures.delete(key);
    else if (kept.length !== times.length) failures.set(key, kept);
    return kept;
  };

  function blocked(keys) {
    const now = Date.now();
    return keys.some((key) => recent(key, now).length >= max);
  }

  function fail(keys) {
    const now = Date.now();
    for (const key of keys) {
      const times = [...recent(key, now), now].slice(-max);
      // Delete first, so the Map's order is least recently failed first.
      failures.delete(key);
      failures.set(key, times);
      while (failures.size > maxKeys)
        failures.delete(failures.keys().next().value);
    }
  }

  return {
    blocked,
    fail,
    clear: () => failures.clear(),
    size: () => failures.size,
  };
}

module.exports = { createLoginLimiter };
