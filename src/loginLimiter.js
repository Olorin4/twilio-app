/* Counts failed logins per key over a rolling window. A key is "prefix:rest"
(for example `ip:203.0.113.1`) and its limit is `limits[prefix]`: a key with
that many failures in the last `windowMs` is blocked until the oldest of them
rolls off. Memory is bounded at `maxKeys`. When it is full, a new key looks at
no more than the `EVICT_SCAN` keys failed longest ago and evicts the one
least close to its limit, never one already at its limit; if every key looked
at is at its limit, the new key is not recorded. So a flood of fresh keys
cannot push an attacked key out, and the request path never scans the whole
map. A key whose failures have all rolled off is deleted when next seen. In
memory only, so it resets on restart and is per process. */

const EVICT_SCAN = 32;

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

  // Makes room for one new key, or returns false when the oldest keys are
  // all at their limit (then the new key is not recorded).
  function makeRoom(now) {
    let victim = null;
    let lowest = Infinity;
    let scanned = 0;
    for (const key of failures.keys()) {
      if (scanned++ >= EVICT_SCAN) break;
      const times = failures.get(key);
      const count = times.filter((at) => now - at < windowMs).length;
      const ratio = count / limitFor(key);
      if (ratio < 1 && ratio < lowest) {
        victim = key;
        lowest = ratio;
        if (ratio === 0) break; // all rolled off: nothing to lose
      }
    }
    if (victim === null) return false;
    failures.delete(victim);
    return true;
  }

  // Records a failure on each key. Returns the keys that this failure took
  // to their limit, so the caller can tell the operator.
  function fail(keys) {
    const now = Date.now();
    const reached = [];
    for (const key of keys) {
      const limit = limitFor(key);
      const before = recent(key, now);
      if (!failures.has(key) && failures.size >= maxKeys && !makeRoom(now))
        continue;
      const times = [...before, now].slice(-limit);
      // Delete first, so the Map's order is least recently failed first.
      failures.delete(key);
      failures.set(key, times);
      if (before.length < limit && times.length >= limit) reached.push(key);
    }
    return reached;
  }

  return {
    blocked,
    fail,
    clear: () => failures.clear(),
    size: () => failures.size,
  };
}

module.exports = { createLoginLimiter };
