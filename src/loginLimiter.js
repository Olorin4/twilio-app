/* Counts failed logins per key over a rolling window. A key is "prefix:rest"
(for example `ip:203.0.113.1`) and its limit is `limits[prefix]`: a key with
that many failures in the last `windowMs` is blocked until the oldest of them
rolls off. Memory is bounded: past `maxKeys` the key touched
longest ago is dropped, and a key whose failures have all rolled off is
deleted when next seen. In memory only, so it resets on restart and is per
process. */

function createLoginLimiter({
  limits = { ip: 30, ipuser: 10, user: 100 },
  windowMs = 60 * 1000,
  maxKeys = 10000,
} = {}) {
  // key -> timestamps of recent failures, oldest first (at most its limit).
  const failures = new Map();

  const limitFor = (key) => {
    const max = limits[key.slice(0, key.indexOf(":"))];
    if (!Number.isInteger(max) || max < 1)
      throw new Error(`No sign-in limit for key ${key}`);
    return max;
  };

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
    return keys.some((key) => recent(key, now).length >= limitFor(key));
  }

  function fail(keys) {
    const now = Date.now();
    for (const key of keys) {
      const times = [...recent(key, now), now].slice(-limitFor(key));
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
