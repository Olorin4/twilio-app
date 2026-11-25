/* Agent profiles: the per-workspace AI agents (Jack and the like). Every save
writes a revision in the same transaction; restoring a revision is itself a
save, so the text it replaces is never lost. */

const crypto = require("crypto");
const pool = require("./db");
const { inTransaction } = require("./workspaceConnections");
const { getConfig } = require("./receptionist/config");
const { KINDS, defaultDailyLimit } = require("./receptionist/kinds");
const { JACK } = require("./receptionist/seed/jack");
const { IRON_WING_WORKSPACE_ID } = require("./workspaceContext");

const INVALID = "Enter valid agent settings";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Editable fields: camelCase name, column, accepted snake_case alias.
const FIELDS = [
  ["name", "name", "name"],
  ["personaName", "persona_name", "persona_name"],
  ["companyName", "company_name", "company_name"],
  ["greeting", "greeting", "greeting"],
  ["instructions", "instructions", "instructions"],
  ["knowledge", "knowledge", "knowledge"],
  ["voice", "voice", "voice"],
  ["alertEmail", "alert_email", "alert_email"],
  ["dailyLimit", "daily_limit", "daily_limit"],
  ["enabled", "enabled", "enabled"],
  ["aiDisclosure", "ai_disclosure", "ai_disclosure"],
];
// How the agent tells callers it is an AI. It always says so when asked;
// "in_greeting" also says so in the greeting. There is deliberately no
// option to deny it.
const DISCLOSURES = ["when_asked", "in_greeting"];
const REQUIRED_ON_CREATE = ["name", "personaName", "companyName", "greeting"];
const SHORT = { name: 120, personaName: 120, companyName: 120, voice: 64 };
const LONG = { greeting: 500, instructions: 20000, knowledge: 60000 };

const fail = (reason) => new Error(`${INVALID}: ${reason}.`);

function pick(fields, camel, alias) {
  if (fields[camel] !== undefined) return fields[camel];
  return fields[alias];
}

// Normalises the editable fields that are present. `kind` is checked when
// supplied. Required fields are enforced by createProfile, not here, so an
// update can send only what changed.
function validateFields(fields = {}) {
  const out = {};
  if (fields.kind !== undefined) {
    if (!KINDS.includes(fields.kind)) throw fail("unknown agent kind");
    out.kind = fields.kind;
  }
  for (const [camel, , alias] of FIELDS) {
    const value = pick(fields, camel, alias);
    if (value === undefined) continue;
    if (camel === "enabled") {
      if (typeof value !== "boolean")
        throw fail("enabled must be true or false");
      out.enabled = value;
    } else if (camel === "dailyLimit") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 1000)
        throw fail("daily limit must be a whole number from 1 to 1000");
      out.dailyLimit = n;
    } else if (camel === "alertEmail") {
      const email = value === null ? "" : String(value).trim();
      if (email && !/^[^\s@]+@[^\s@]+$/.test(email))
        throw fail("alert email is not an email address");
      out.alertEmail = email || null;
    } else if (camel === "aiDisclosure") {
      if (!DISCLOSURES.includes(value))
        throw fail("AI disclosure must be when_asked or in_greeting");
      out.aiDisclosure = value;
    } else if (camel === "voice") {
      const voice = value === null ? "" : String(value).trim();
      if (voice.length > SHORT.voice) throw fail("voice is too long");
      out.voice = voice || null;
    } else {
      if (typeof value !== "string") throw fail(`${camel} must be text`);
      if (camel in SHORT) {
        const text = value.trim();
        if (text.length < 1 || text.length > SHORT[camel])
          throw fail(`${camel} must be 1 to ${SHORT[camel]} characters`);
        out[camel] = text;
      } else {
        if (value.length > LONG[camel])
          throw fail(`${camel} is longer than ${LONG[camel]} characters`);
        if (camel === "greeting" && !value.trim())
          throw fail("greeting is required");
        out[camel] = value;
      }
    }
  }
  return out;
}

function toProfile(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    name: row.name,
    personaName: row.persona_name,
    companyName: row.company_name,
    greeting: row.greeting,
    instructions: row.instructions,
    knowledge: row.knowledge,
    voice: row.voice,
    alertEmail: row.alert_email,
    dailyLimit: row.daily_limit,
    enabled: row.enabled,
    isDefault: row.is_default,
    aiDisclosure: row.ai_disclosure || "when_asked",
  };
}

// An agent set to disclose in its greeting must actually say so there.
function checkDisclosure({ aiDisclosure, greeting }) {
  if (aiDisclosure === "in_greeting" && !/\bAI\b/i.test(greeting || ""))
    throw fail(
      "with disclosure in the greeting, the greeting must say the caller is talking to an AI assistant",
    );
}

// What a revision records: every editable field, kind excluded (it is fixed).
function revisionFields(row) {
  const profile = toProfile(row);
  const out = {};
  for (const [camel] of FIELDS) out[camel] = profile[camel];
  return out;
}

const COLUMNS = `id, workspace_id, kind, name, persona_name, company_name,
  greeting, instructions, knowledge, voice, alert_email, daily_limit,
  enabled, is_default, ai_disclosure`;

function checkId(id, what = "Agent") {
  if (!uuidPattern.test(id || "")) throw new Error(`${what} does not exist.`);
}
function checkWorkspace(workspaceId) {
  if (!uuidPattern.test(workspaceId || ""))
    throw new Error("Invalid workspace.");
}

async function addRevision(client, row, savedBy) {
  await client.query(
    `INSERT INTO agent_profile_revisions (profile_id, fields, saved_by)
     VALUES ($1, $2, $3)`,
    [row.id, JSON.stringify(revisionFields(row)), String(savedBy)],
  );
}

async function listProfiles(workspaceId) {
  checkWorkspace(workspaceId);
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM agent_profiles WHERE workspace_id = $1
     ORDER BY is_default DESC, lower(name), id`,
    [workspaceId],
  );
  return rows.map(toProfile);
}

async function getProfile(id) {
  if (!uuidPattern.test(id || "")) return null;
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM agent_profiles WHERE id = $1`,
    [id],
  );
  return rows.length ? toProfile(rows[0]) : null;
}

async function getDefaultProfile(workspaceId) {
  if (!uuidPattern.test(workspaceId || "")) return null;
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM agent_profiles
     WHERE workspace_id = $1 AND is_default`,
    [workspaceId],
  );
  return rows.length ? toProfile(rows[0]) : null;
}

async function insertProfile(client, workspaceId, clean, savedBy, isDefault) {
  const id = crypto.randomUUID();
  const { rows } = await client.query(
    `INSERT INTO agent_profiles
       (id, workspace_id, kind, name, persona_name, company_name, greeting,
        instructions, knowledge, voice, alert_email, daily_limit, enabled,
        is_default, ai_disclosure)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING ${COLUMNS}`,
    [
      id,
      workspaceId,
      clean.kind,
      clean.name,
      clean.personaName,
      clean.companyName,
      clean.greeting,
      clean.instructions ?? "",
      clean.knowledge ?? "",
      clean.voice ?? null,
      clean.alertEmail ?? null,
      clean.dailyLimit,
      clean.enabled ?? true,
      isDefault,
      clean.aiDisclosure ?? "when_asked",
    ],
  );
  await addRevision(client, rows[0], savedBy);
  return toProfile(rows[0]);
}

async function createProfile(workspaceId, fields, savedBy) {
  checkWorkspace(workspaceId);
  const clean = validateFields(fields);
  if (!clean.kind) throw fail("choose an agent kind");
  for (const key of REQUIRED_ON_CREATE)
    if (clean[key] === undefined) throw fail(`${key} is required`);
  if (clean.dailyLimit === undefined)
    clean.dailyLimit = defaultDailyLimit(clean.kind, getConfig(process.env));
  checkDisclosure(clean);
  return inTransaction((client) =>
    insertProfile(client, workspaceId, clean, savedBy, false),
  );
}

// Applies a validated partial change inside a transaction and records it.
async function applyUpdate(client, workspaceId, id, clean, savedBy) {
  const sets = [];
  const values = [workspaceId, id];
  for (const [camel, column] of FIELDS) {
    if (clean[camel] === undefined) continue;
    values.push(clean[camel]);
    sets.push(`${column} = $${values.length}`);
  }
  sets.push("updated_at = now()");
  const { rows } = await client.query(
    `UPDATE agent_profiles SET ${sets.join(", ")}
     WHERE workspace_id = $1 AND id = $2
     RETURNING ${COLUMNS}`,
    values,
  );
  if (!rows.length) throw new Error("Agent does not exist.");
  // Checked on the stored result, so a change to either field is judged
  // against the other; throwing here rolls the update back.
  checkDisclosure(toProfile(rows[0]));
  await addRevision(client, rows[0], savedBy);
  return toProfile(rows[0]);
}

async function updateProfile(workspaceId, id, fields, savedBy) {
  checkWorkspace(workspaceId);
  checkId(id);
  const clean = validateFields(fields);
  delete clean.kind; // kind is fixed after creation
  return inTransaction((client) =>
    applyUpdate(client, workspaceId, id, clean, savedBy),
  );
}

async function setDefault(workspaceId, id) {
  checkWorkspace(workspaceId);
  checkId(id);
  return inTransaction(async (client) => {
    await client.query(
      "UPDATE agent_profiles SET is_default = false WHERE workspace_id = $1 AND is_default",
      [workspaceId],
    );
    const { rows } = await client.query(
      `UPDATE agent_profiles SET is_default = true, updated_at = now()
       WHERE workspace_id = $1 AND id = $2
       RETURNING ${COLUMNS}`,
      [workspaceId, id],
    );
    if (!rows.length) throw new Error("Agent does not exist.");
    return toProfile(rows[0]);
  });
}

async function listRevisions(workspaceId, id) {
  checkWorkspace(workspaceId);
  checkId(id);
  const { rows } = await pool.query(
    `SELECT r.id, r.saved_by, r.saved_at, r.fields
     FROM agent_profile_revisions r
     JOIN agent_profiles p ON p.id = r.profile_id
     WHERE p.workspace_id = $1 AND p.id = $2
     ORDER BY r.saved_at DESC, r.id DESC`,
    [workspaceId, id],
  );
  return rows.map((r) => ({
    id: r.id,
    savedBy: r.saved_by,
    savedAt: r.saved_at,
    fields: r.fields,
  }));
}

async function restoreRevision(workspaceId, id, revisionId, savedBy) {
  checkWorkspace(workspaceId);
  checkId(id);
  if (!/^\d+$/.test(String(revisionId)))
    throw new Error("Revision does not exist.");
  return inTransaction(async (client) => {
    const found = await client.query(
      `SELECT r.fields FROM agent_profile_revisions r
       JOIN agent_profiles p ON p.id = r.profile_id
       WHERE p.workspace_id = $1 AND p.id = $2 AND r.id = $3`,
      [workspaceId, id, revisionId],
    );
    if (!found.rows.length) throw new Error("Revision does not exist.");
    const clean = validateFields(found.rows[0].fields);
    delete clean.kind;
    return applyUpdate(client, workspaceId, id, clean, savedBy);
  });
}

// Insert-only: Iron Wing's default profile is created from JACK once and never
// overwritten, so edits made in the app survive a rerun.
async function seedJack() {
  return inTransaction(async (client) => {
    const existing = await client.query(
      "SELECT 1 FROM agent_profiles WHERE workspace_id = $1 AND is_default",
      [IRON_WING_WORKSPACE_ID],
    );
    if (existing.rows.length) return { created: false };
    const clean = validateFields(JACK);
    clean.kind = JACK.kind;
    clean.dailyLimit = defaultDailyLimit(JACK.kind, getConfig(process.env));
    await insertProfile(client, IRON_WING_WORKSPACE_ID, clean, "import", true);
    return { created: true };
  });
}

module.exports = {
  listProfiles,
  getProfile,
  getDefaultProfile,
  createProfile,
  updateProfile,
  setDefault,
  listRevisions,
  restoreRevision,
  validateFields,
  seedJack,
};
