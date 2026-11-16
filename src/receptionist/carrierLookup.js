/* Checks an MC or USDOT number against FMCSA's public company census on
data.transportation.gov, so the agent can confirm a carrier by name. The
lookup happens during a live call, so it has a short timeout and never
throws. */

const CENSUS_URL = "https://data.transportation.gov/resource/az4n-8mr2.json";
const FIELDS = [
  "dot_number",
  "legal_name",
  "dba_name",
  "phy_city",
  "phy_state",
  "power_units",
  "total_drivers",
  "status_code",
  "add_date",
  "docket1prefix",
  "docket1",
  "docket2prefix",
  "docket2",
  "docket3prefix",
  "docket3",
];
const SLOTS = [1, 2, 3];
const TIMEOUT = Symbol("timeout");

// "MC 0123-4567" → { kind: "mc", digits: "1234567" }. The census stores
// docket and DOT numbers without leading zeros.
function parseDocket(input) {
  const raw = typeof input === "string" ? input : "";
  const digits = raw.replace(/\D/g, "").replace(/^0+/, "");
  if (digits.length < 1 || digits.length > 8)
    return { kind: null, digits: null };
  return { kind: /dot/i.test(raw) ? "usdot" : "mc", digits };
}

const speakDigits = (digits) => String(digits).split("").join(" ");

const text = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const count = (value) => (/^\d+$/.test(value || "") ? Number(value) : null);

function mcOf(row) {
  for (const slot of SLOTS) {
    const number = text(row[`docket${slot}`]);
    if (row[`docket${slot}prefix`] === "MC" && /^\d+$/.test(number || ""))
      return number.replace(/^0+/, "");
  }
  return null;
}

async function lookupCarrier(
  { kind, digits } = {},
  { fetchImpl = fetch, timeoutMs = 2500 } = {},
) {
  // Only digits are ever placed in the query.
  if (!["mc", "usdot"].includes(kind) || !/^\d{1,8}$/.test(digits || ""))
    return { found: false, reason: "error" };
  const where =
    kind === "usdot"
      ? `dot_number='${digits}'`
      : SLOTS.map(
          (slot) => `(docket${slot}prefix='MC' AND docket${slot}='${digits}')`,
        ).join(" OR ");
  const url = `${CENSUS_URL}?${new URLSearchParams({
    $select: FIELDS.join(","),
    $where: where,
    $limit: "2",
  })}`;
  const controller = new AbortController();
  let timer;
  try {
    const rows = await Promise.race([
      (async () => {
        const response = await fetchImpl(url, { signal: controller.signal });
        if (!response.ok)
          throw new Error(`FMCSA census HTTP ${response.status}`);
        return response.json();
      })(),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(TIMEOUT), timeoutMs);
      }),
    ]);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return { found: false, reason: "no_match" };
    const since = /^(\d{4})\d{4}$/.exec(row.add_date || "");
    return {
      found: true,
      usdot: text(row.dot_number),
      mc: kind === "mc" ? digits : mcOf(row),
      legalName: text(row.legal_name),
      dbaName: text(row.dba_name),
      city: text(row.phy_city),
      state: text(row.phy_state),
      powerUnits: count(row.power_units),
      drivers: count(row.total_drivers),
      usdotActive: row.status_code === "A",
      since: since ? Number(since[1]) : null,
    };
  } catch (error) {
    if (error === TIMEOUT || error?.name === "TimeoutError")
      return { found: false, reason: "timeout" };
    return { found: false, reason: "error" };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

module.exports = { parseDocket, speakDigits, lookupCarrier };
