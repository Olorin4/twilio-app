const { randomUUID } = require("crypto");
const pool = require("./db");
const {
  encryptCredentials,
  decryptCredentials,
} = require("./credentialEncryption");
const { validateTwilioConnection } = require("./twilioConnectionValidation");
const { IRON_WING_WORKSPACE_ID } = require("./workspaceContext");

const PERSONAL_AGENT_ERROR =
  "A personal line can't be answered by an AI agent.";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The user must be signed in; members see only workspaces they belong to.
function listScope(user) {
  if (!user) throw new Error("A signed-in user is required.");
  if (user.role === "owner") return null;
  if (user.role !== "member" || !user.id)
    throw new Error("A signed-in user is required.");
  return user.id;
}

async function listWorkspaces(user) {
  const memberId = listScope(user);
  const params = [IRON_WING_WORKSPACE_ID, process.env.TWILIO_CALLER_ID || null];
  if (memberId) params.push(memberId);
  const result = await pool.query(
    `SELECT w.id, w.name, w.created_at, n.id AS active_number_id,
      c.id AS active_connection_id, COALESCE(n.phone_number, CASE WHEN w.id = $1::uuid THEN $2::text ELSE NULL END) AS active_phone,
      n.voice_enabled AS active_voice_enabled, n.sms_enabled AS active_sms_enabled
     FROM workspaces w
     ${memberId ? "JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = $3" : ""}
     LEFT JOIN workspace_active_numbers a ON a.workspace_id = w.id
     LEFT JOIN connection_numbers n ON n.id = a.connection_number_id
     LEFT JOIN provider_connections c ON c.id = n.connection_id AND c.workspace_id = w.id
     WHERE w.archived_at IS NULL
     ORDER BY lower(w.name), w.id`,
    params,
  );
  // The active number may be someone's personal line; members get theirs
  // from /me/lines instead.
  if (memberId) for (const row of result.rows) row.active_phone = null;
  return result.rows;
}
/* One softphone target per connection. Owners get the workspace's active
number when it is on that connection; a member gets their own first assigned
voice line on it (by assignment time), and connections where they have none
are left out, so no other line's number reaches them. */
async function listVoiceTargets(user) {
  const memberId = listScope(user);
  const result = await pool.query(
    `SELECT DISTINCT ON (c.id) c.id AS connection_id, w.id AS workspace_id, w.name AS workspace_name,
      n.id AS number_id, n.phone_number
    FROM provider_connections c JOIN workspaces w ON w.id = c.workspace_id
    ${memberId ? "JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = $1" : ""}
    JOIN connection_numbers n ON n.connection_id = c.id
    ${memberId ? "JOIN number_assignees na ON na.number_id = n.id AND na.user_id = $1" : ""}
    LEFT JOIN workspace_active_numbers a ON a.workspace_id = w.id
    WHERE n.voice_enabled = true AND w.archived_at IS NULL
    ORDER BY ${memberId ? "c.id, na.created_at, n.id" : "c.id, (a.connection_number_id = n.id) DESC NULLS LAST, n.id"}`,
    memberId ? [memberId] : [],
  );
  const targets = result.rows;
  // The legacy number is owners only.
  if (!memberId && process.env.TWILIO_CALLER_ID) {
    const iron = await pool.query("SELECT name FROM workspaces WHERE id = $1", [
      IRON_WING_WORKSPACE_ID,
    ]);
    if (iron.rows.length)
      targets.push({
        connection_id: "legacy",
        workspace_id: IRON_WING_WORKSPACE_ID,
        workspace_name: iron.rows[0].name,
        number_id: null,
        phone_number: process.env.TWILIO_CALLER_ID,
      });
  }
  return targets;
}

async function createWorkspace(name) {
  const clean = workspaceName(name);
  const result = await pool.query(
    "INSERT INTO workspaces (id, name) VALUES ($1, $2) RETURNING id, name, created_at",
    [randomUUID(), clean],
  );
  return result.rows[0];
}

function workspaceName(name) {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 120)
    throw new Error("Enter a workspace name of up to 120 characters.");
  return name.trim();
}
function workspaceId(id) {
  if (!uuidPattern.test(id || "")) throw new Error("Invalid workspace.");
  return id;
}
async function renameWorkspace(id, name) {
  const clean = workspaceName(name);
  workspaceId(id);
  const result = await pool.query(
    `UPDATE workspaces SET name = $2 WHERE id = $1 AND archived_at IS NULL
     RETURNING id, name, created_at`,
    [id, clean],
  );
  if (!result.rows.length) throw new Error("Workspace does not exist.");
  return result.rows[0];
}
async function archiveWorkspace(id) {
  workspaceId(id);
  if (id.toLowerCase() === IRON_WING_WORKSPACE_ID)
    throw new Error("The Iron Wing workspace cannot be archived.");
  // One statement, so an archived workspace never keeps its numbers. The
  // numbers stay on the Twilio account and can be added to another workspace.
  const result = await pool.query(
    `WITH archived AS (
       UPDATE workspaces SET archived_at = now()
       WHERE id = $1 AND archived_at IS NULL RETURNING id
     ), cleared AS (
       DELETE FROM workspace_active_numbers
       WHERE workspace_id IN (SELECT id FROM archived)
     ), freed AS (
       DELETE FROM connection_numbers WHERE connection_id IN (
         SELECT id FROM provider_connections
         WHERE workspace_id IN (SELECT id FROM archived))
     )
     SELECT id FROM archived`,
    [id],
  );
  if (!result.rows.length) throw new Error("Workspace does not exist.");
  return { id: result.rows[0].id, archived: true };
}

async function listAllConnections() {
  const result = await pool.query(
    `SELECT c.id, c.name, c.account_sid, c.workspace_id, w.name AS workspace_name
     FROM provider_connections c JOIN workspaces w ON w.id = c.workspace_id
     WHERE w.archived_at IS NULL
     ORDER BY lower(w.name), lower(c.name), c.id`,
  );
  return result.rows;
}

async function inTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Removes a number from the app only. History is untouched and the number
// stays in the Twilio account, so it can be added to any workspace afterwards.
async function releaseNumber(workspaceId, numberId) {
  if (!uuidPattern.test(workspaceId || "") || !uuidPattern.test(numberId || ""))
    throw new Error("Invalid workspace or number.");
  return inTransaction(async (client) => {
    await client.query(
      "DELETE FROM workspace_active_numbers WHERE connection_number_id = $1 AND workspace_id = $2",
      [numberId, workspaceId],
    );
    const result = await client.query(
      `DELETE FROM connection_numbers n USING provider_connections c
       WHERE n.id = $1 AND c.id = n.connection_id AND c.workspace_id = $2
       RETURNING n.phone_number`,
      [numberId, workspaceId],
    );
    if (!result.rows.length)
      throw new Error("Number does not belong to this workspace.");
    return { released: true, phone_number: result.rows[0].phone_number };
  });
}

// Re-points a number to another connection on the same Twilio account. Twilio's
// own webhook URLs for the number are not changed here.
async function moveNumber(workspaceId, numberId, targetConnectionId) {
  if (
    !uuidPattern.test(workspaceId || "") ||
    !uuidPattern.test(numberId || "") ||
    !uuidPattern.test(targetConnectionId || "")
  )
    throw new Error("Invalid workspace or number.");
  return inTransaction(async (client) => {
    const source = await client.query(
      `SELECT n.id, n.phone_number, n.connection_id, c.account_sid
       FROM connection_numbers n JOIN provider_connections c ON c.id = n.connection_id
       WHERE n.id = $1 AND c.workspace_id = $2 FOR UPDATE OF n`,
      [numberId, workspaceId],
    );
    if (!source.rows.length)
      throw new Error("Number does not belong to this workspace.");
    const number = source.rows[0];
    if (number.connection_id === targetConnectionId)
      throw new Error("Choose a different connection.");
    const target = await client.query(
      `SELECT c.id, c.workspace_id, c.account_sid
       FROM provider_connections c JOIN workspaces w ON w.id = c.workspace_id
       WHERE c.id = $1 AND w.archived_at IS NULL`,
      [targetConnectionId],
    );
    if (!target.rows.length) throw new Error("Connection does not exist.");
    if (target.rows[0].account_sid !== number.account_sid)
      throw new Error(
        "To move a number to another Twilio account, transfer it in Twilio first, then add it to a connection on that account.",
      );
    await client.query(
      "DELETE FROM workspace_active_numbers WHERE connection_number_id = $1",
      [numberId],
    );
    // The people on the line belong to the old workspace too; with none, the
    // line rings the owners until someone is assigned.
    await client.query("DELETE FROM number_assignees WHERE number_id = $1", [
      numberId,
    ]);
    await client.query(
      `UPDATE connection_numbers SET connection_id = $2, handler = 'softphone', agent_profile_id = NULL,
         personal = false
       WHERE id = $1 RETURNING id`,
      [numberId, targetConnectionId],
    );
    return {
      moved: true,
      id: numberId,
      phone_number: number.phone_number,
      workspace_id: target.rows[0].workspace_id,
      connection_id: targetConnectionId,
    };
  });
}

// Per-number handling: softphone rings the browser, ai_agent answers with an
// agent profile from the same workspace. Moving a number resets the handler
// (see moveNumber) because the agent belongs to the old workspace.
async function updateNumberSettings(workspaceId, numberId, settings = {}) {
  if (!uuidPattern.test(workspaceId || "") || !uuidPattern.test(numberId || ""))
    throw new Error("Invalid workspace or number.");
  const { handler, agentProfileId, label, observeHours, personal } = settings;
  if (handler !== "softphone" && handler !== "ai_agent")
    throw new Error("Enter valid number settings.");
  if (observeHours !== undefined && typeof observeHours !== "boolean")
    throw new Error("Enter valid number settings.");
  if (personal !== undefined && typeof personal !== "boolean")
    throw new Error("Enter valid number settings.");
  if (personal === true && handler === "ai_agent")
    throw new Error(PERSONAL_AGENT_ERROR);
  let cleanLabel;
  if (label !== undefined && label !== null) {
    if (typeof label !== "string" || label.trim().length > 60)
      throw new Error("Enter a line label of up to 60 characters.");
    cleanLabel = label.trim() || null;
  } else if (label === null) cleanLabel = null;
  return inTransaction(async (client) => {
    const current = await client.query(
      `SELECT n.id, n.label, n.observe_hours, n.personal
       FROM connection_numbers n JOIN provider_connections c ON c.id = n.connection_id
       WHERE n.id = $1 AND c.workspace_id = $2 FOR UPDATE OF n`,
      [numberId, workspaceId],
    );
    if (!current.rows.length)
      throw new Error("Number does not belong to this workspace.");
    const nextPersonal =
      personal === undefined ? current.rows[0].personal === true : personal;
    if (nextPersonal && handler === "ai_agent")
      throw new Error(PERSONAL_AGENT_ERROR);
    let profileId = null;
    if (handler === "ai_agent") {
      if (!uuidPattern.test(agentProfileId || ""))
        throw new Error("Choose an agent from this workspace.");
      const profile = await client.query(
        `SELECT p.id FROM agent_profiles p
         WHERE p.id = $1 AND p.workspace_id = $2`,
        [agentProfileId, workspaceId],
      );
      if (!profile.rows.length)
        throw new Error("Choose an agent from this workspace.");
      profileId = profile.rows[0].id;
    }
    const row = current.rows[0];
    const updated = await client.query(
      `UPDATE connection_numbers
       SET handler = $2, agent_profile_id = $3, label = $4, observe_hours = $5, personal = $6
       WHERE id = $1
       RETURNING id, handler, agent_profile_id, label, observe_hours, personal`,
      [
        numberId,
        handler,
        profileId,
        cleanLabel === undefined ? row.label : cleanLabel,
        observeHours === undefined ? row.observe_hours : observeHours,
        nextPersonal,
      ],
    );
    return updated.rows[0];
  });
}

// Users who may be put on a line: enabled, and an owner or a member of the
// line's workspace. The ring list (src/ringing.js) applies the same rule.
const CAN_OPEN_WORKSPACE = `u.enabled AND (u.role = 'owner' OR EXISTS (
  SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = $2 AND wm.user_id = u.id))`;
const ASSIGNEES_ERROR = "Choose people who can open this workspace.";

// Replaces who a line rings. People already on it keep their place in the
// ring order; new ones follow in the order given. An empty list clears it,
// so it rings the owners.
async function setNumberAssignees(workspaceId, numberId, userIds) {
  if (!uuidPattern.test(workspaceId || "") || !uuidPattern.test(numberId || ""))
    throw new Error("Invalid workspace or number.");
  if (
    !Array.isArray(userIds) ||
    userIds.some((id) => typeof id !== "string" || !uuidPattern.test(id))
  )
    throw new Error(ASSIGNEES_ERROR);
  const ids = userIds.map((id) => id.toLowerCase());
  if (new Set(ids).size !== ids.length) throw new Error(ASSIGNEES_ERROR);
  return inTransaction(async (client) => {
    const number = await client.query(
      `SELECT n.id FROM connection_numbers n JOIN provider_connections c ON c.id = n.connection_id
       WHERE n.id = $1 AND c.workspace_id = $2 FOR UPDATE OF n`,
      [numberId, workspaceId],
    );
    if (!number.rows.length)
      throw new Error("Number does not belong to this workspace.");
    if (ids.length) {
      const allowed = await client.query(
        `SELECT u.id FROM app_users u
         WHERE u.id = ANY($1::uuid[]) AND ${CAN_OPEN_WORKSPACE}`,
        [ids, workspaceId],
      );
      if (allowed.rows.length !== ids.length) throw new Error(ASSIGNEES_ERROR);
    }
    await client.query(
      "DELETE FROM number_assignees WHERE number_id = $1 AND NOT (user_id = ANY($2::uuid[]))",
      [numberId, ids],
    );
    if (ids.length)
      await client.query(
        `INSERT INTO number_assignees (number_id, user_id, created_at)
         SELECT $1, person.id, now() + person.ord * interval '1 microsecond'
         FROM unnest($2::uuid[]) WITH ORDINALITY AS person(id, ord)
         ON CONFLICT (number_id, user_id) DO NOTHING`,
        [numberId, ids],
      );
    return { numberId, userIds: ids };
  });
}

async function listConnections(workspaceId) {
  if (!uuidPattern.test(workspaceId || ""))
    throw new Error("Invalid workspace.");
  const result = await pool.query(
    `SELECT id, workspace_id, provider, name, account_sid, twiml_app_sid, created_at, updated_at
    FROM provider_connections WHERE workspace_id = $1 ORDER BY lower(name), id`,
    [workspaceId],
  );
  const numbers = await pool.query(
    `SELECT n.id, n.connection_id, n.provider_number_sid, n.phone_number, n.voice_enabled, n.sms_enabled,
      n.handler, n.agent_profile_id, n.label, n.observe_hours, n.personal,
      (a.connection_number_id = n.id) AS active
    FROM connection_numbers n JOIN provider_connections c ON c.id = n.connection_id
    LEFT JOIN workspace_active_numbers a ON a.workspace_id = c.workspace_id
    WHERE c.workspace_id = $1 ORDER BY n.phone_number`,
    [workspaceId],
  );
  // Only the people the line actually rings, in ring order.
  const assignees = numbers.rows.length
    ? (
        await pool.query(
          `SELECT na.number_id, u.id, u.display_name
           FROM number_assignees na JOIN app_users u ON u.id = na.user_id
           WHERE na.number_id = ANY($1::uuid[]) AND ${CAN_OPEN_WORKSPACE}
           ORDER BY na.created_at, u.id`,
          [numbers.rows.map((number) => number.id), workspaceId],
        )
      ).rows
    : [];
  return result.rows.map((row) => ({
    ...row,
    numbers: numbers.rows
      .filter((number) => number.connection_id === row.id)
      .map((number) => ({
        ...number,
        assignees: assignees
          .filter((person) => person.number_id === number.id)
          .map((person) => ({
            id: person.id,
            displayName: person.display_name,
          })),
      })),
  }));
}

async function selectNumber(workspaceId, numberId) {
  if (!uuidPattern.test(workspaceId || "") || !uuidPattern.test(numberId || ""))
    throw new Error("Invalid workspace or number.");
  const result = await pool.query(
    `INSERT INTO workspace_active_numbers (workspace_id, connection_number_id)
    SELECT c.workspace_id, n.id FROM connection_numbers n JOIN provider_connections c ON c.id = n.connection_id
    WHERE c.workspace_id = $1 AND n.id = $2
    ON CONFLICT (workspace_id) DO UPDATE SET connection_number_id = EXCLUDED.connection_number_id, updated_at = now()
    RETURNING workspace_id, connection_number_id`,
    [workspaceId, numberId],
  );
  if (!result.rows.length)
    throw new Error("Number does not belong to this workspace.");
  return result.rows[0];
}
async function selectLegacy(workspaceId) {
  if (workspaceId !== IRON_WING_WORKSPACE_ID)
    throw new Error(
      "The environment connection is only available to Iron Wing.",
    );
  await pool.query(
    "DELETE FROM workspace_active_numbers WHERE workspace_id = $1",
    [workspaceId],
  );
  return { workspace_id: workspaceId, legacy: true };
}

async function updateConnectionCredentials(
  workspaceId,
  connectionId,
  credentials,
  options = {},
) {
  if (
    !uuidPattern.test(workspaceId || "") ||
    !uuidPattern.test(connectionId || "")
  )
    throw new Error("Invalid workspace or connection.");
  const existing = await pool.query(
    `SELECT id, account_sid, twiml_app_sid, encrypted_credentials FROM provider_connections
    WHERE id = $1 AND workspace_id = $2 AND provider = 'twilio'`,
    [connectionId, workspaceId],
  );
  if (!existing.rows.length)
    throw new Error("Connection does not exist in this workspace.");
  const row = existing.rows[0];
  if (
    credentials?.accountSid !== row.account_sid ||
    credentials?.twimlAppSid !== row.twiml_app_sid
  )
    throw new Error(
      "To use a different Twilio account or TwiML App, add a new connection.",
    );
  const validate = options.validate || validateTwilioConnection;
  const verified = await validate(credentials);
  const assigned = await pool.query(
    "SELECT provider_number_sid, phone_number FROM connection_numbers WHERE connection_id = $1",
    [connectionId],
  );
  if (
    assigned.rows.some(
      (assignedNumber) =>
        !verified.numbers.some(
          (number) =>
            number.sid === assignedNumber.provider_number_sid &&
            number.phoneNumber === assignedNumber.phone_number,
        ),
    )
  )
    throw new Error(
      "The updated account no longer owns every assigned number.",
    );
  const envelope = encryptCredentials(connectionId, {
    authToken: credentials.authToken,
    apiKeySid: credentials.apiKeySid,
    apiKeySecret: credentials.apiKeySecret,
    twimlAppSid: credentials.twimlAppSid,
  });
  // Verify the old key and detect concurrent updates before replacing secrets.
  decryptCredentials(connectionId, row.encrypted_credentials);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE provider_connections SET encrypted_credentials = $3::jsonb, updated_at = now()
      WHERE id = $1 AND workspace_id = $2 AND encrypted_credentials = $4::jsonb RETURNING id`,
      [
        connectionId,
        workspaceId,
        JSON.stringify(envelope),
        JSON.stringify(row.encrypted_credentials),
      ],
    );
    if (!updated.rows.length)
      throw new Error("Connection changed while validating. Please try again.");
    const currentNumbers = await client.query(
      "SELECT provider_number_sid, phone_number FROM connection_numbers WHERE connection_id = $1",
      [connectionId],
    );
    if (
      currentNumbers.rows.some(
        (assignedNumber) =>
          !verified.numbers.some(
            (number) =>
              number.sid === assignedNumber.provider_number_sid &&
              number.phoneNumber === assignedNumber.phone_number,
          ),
      )
    )
      throw new Error(
        "The updated account no longer owns every assigned number.",
      );
    for (const number of verified.numbers) {
      await client.query(
        `UPDATE connection_numbers SET voice_enabled = $3, sms_enabled = $4
        WHERE connection_id = $1 AND provider_number_sid = $2`,
        [connectionId, number.sid, number.voice, number.sms],
      );
    }
    await client.query("COMMIT");
    return { id: connectionId, updated: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function readConnectionCredentials(workspaceId, connectionId) {
  if (
    !uuidPattern.test(workspaceId || "") ||
    !uuidPattern.test(connectionId || "")
  )
    throw new Error("Invalid workspace or connection.");
  const result = await pool.query(
    "SELECT id, account_sid, encrypted_credentials FROM provider_connections WHERE id = $1 AND workspace_id = $2 AND provider = 'twilio'",
    [connectionId, workspaceId],
  );
  if (!result.rows.length)
    throw new Error("Connection does not exist in this workspace.");
  const row = result.rows[0];
  return {
    row,
    credentials: {
      accountSid: row.account_sid,
      ...decryptCredentials(row.id, row.encrypted_credentials),
    },
  };
}
async function previewConnectionNumbers(workspaceId, connectionId) {
  const { credentials } = await readConnectionCredentials(
    workspaceId,
    connectionId,
  );
  return validateTwilioConnection(credentials);
}
async function addConnectionNumbers(
  workspaceId,
  connectionId,
  selectedSids,
  options = {},
) {
  if (
    !Array.isArray(selectedSids) ||
    !selectedSids.length ||
    new Set(selectedSids).size !== selectedSids.length ||
    selectedSids.some((sid) => typeof sid !== "string")
  )
    throw new Error("Select at least one owned Twilio number.");
  const { row, credentials } = await readConnectionCredentials(
    workspaceId,
    connectionId,
  );
  const verified = await (options.validate || validateTwilioConnection)(
    credentials,
  );
  const selected = verified.numbers.filter((number) =>
    selectedSids.includes(number.sid),
  );
  if (selected.length !== selectedSids.length)
    throw new Error(
      "A selected number does not belong to this Twilio account.",
    );
  const legacyNumbers = [
    process.env.TWILIO_CALLER_ID,
    ...(process.env.TWILIO_PREVIOUS_NUMBERS || "").split(","),
  ]
    .map((number) => (number || "").trim())
    .filter(Boolean);
  // Only Iron Wing's own connection on the legacy account may take a legacy
  // number (moving it there; see legacyLine.js).
  const ownLegacyAccount =
    workspaceId === IRON_WING_WORKSPACE_ID &&
    row.account_sid === process.env.TWILIO_ACCOUNT_SID;
  if (
    !ownLegacyAccount &&
    selected.some((number) => legacyNumbers.includes(number.phoneNumber))
  )
    throw new Error(
      "The current Iron Wing number is already assigned to the environment connection.",
    );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      "SELECT id FROM provider_connections WHERE id = $1 AND workspace_id = $2 AND encrypted_credentials = $3::jsonb FOR UPDATE",
      [connectionId, workspaceId, JSON.stringify(row.encrypted_credentials)],
    );
    if (!locked.rows.length)
      throw new Error("Connection changed while validating. Please try again.");
    const phones = selected.map((number) => number.phoneNumber).sort();
    for (const phone of phones)
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `twilio:number:${phone}`,
      ]);
    const overlap = await client.query(
      "SELECT 1 FROM connection_numbers WHERE phone_number = ANY($1::text[]) AND connection_id <> $2 LIMIT 1",
      [phones, connectionId],
    );
    if (overlap.rows.length)
      throw new Error(
        "One or more numbers are already connected. Each number can belong to only one workspace.",
      );
    for (const number of selected)
      await client.query(
        `INSERT INTO connection_numbers (id, connection_id, provider_number_sid, phone_number, voice_enabled, sms_enabled)
      VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (connection_id, provider_number_sid) DO UPDATE SET voice_enabled = EXCLUDED.voice_enabled, sms_enabled = EXCLUDED.sms_enabled`,
        [
          randomUUID(),
          connectionId,
          number.sid,
          number.phoneNumber,
          number.voice,
          number.sms,
        ],
      );
    await client.query("COMMIT");
    return { added: selected.length };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function createConnection(workspaceId, name, credentials, options = {}) {
  if (!uuidPattern.test(workspaceId || ""))
    throw new Error("Invalid workspace.");
  if (typeof name !== "string" || !name.trim() || name.trim().length > 120)
    throw new Error("Enter a connection name of up to 120 characters.");
  // Validate everything and encrypt before beginning a transaction. Invalid
  // credentials cannot replace or otherwise change an existing connection.
  const connectionId = randomUUID();
  const envelope = encryptCredentials(connectionId, {
    authToken: credentials?.authToken,
    apiKeySid: credentials?.apiKeySid,
    apiKeySecret: credentials?.apiKeySecret,
    twimlAppSid: credentials?.twimlAppSid,
  });
  const validate = options.validate || validateTwilioConnection;
  const validated = await validate(credentials);
  const selectedSids = options.selectedNumberSids;
  if (
    !Array.isArray(selectedSids) ||
    selectedSids.length === 0 ||
    new Set(selectedSids).size !== selectedSids.length ||
    selectedSids.some((sid) => typeof sid !== "string")
  )
    throw new Error("Select at least one owned Twilio number.");
  const selectedNumbers = validated.numbers.filter((number) =>
    selectedSids.includes(number.sid),
  );
  if (selectedNumbers.length !== selectedSids.length)
    throw new Error(
      "A selected number does not belong to this Twilio account.",
    );
  const legacyNumbers = [
    process.env.TWILIO_CALLER_ID,
    ...(process.env.TWILIO_PREVIOUS_NUMBERS || "").split(","),
  ]
    .map((number) => (number || "").trim())
    .filter(Boolean);
  if (
    selectedNumbers.some((number) => legacyNumbers.includes(number.phoneNumber))
  )
    throw new Error(
      "The current Iron Wing number is already assigned to the environment connection.",
    );
  if (
    credentials.accountSid === process.env.TWILIO_ACCOUNT_SID &&
    credentials.twimlAppSid === process.env.TWILIO_TWIML_APP_SID
  )
    throw new Error(
      "The existing Iron Wing TwiML App cannot be reused by a saved connection. Use a separate TwiML App.",
    );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workspace = await client.query(
      "SELECT id FROM workspaces WHERE id = $1 FOR UPDATE",
      [workspaceId],
    );
    if (!workspace.rows.length) throw new Error("Workspace does not exist.");
    // Lock by E.164 number in a stable order, including across accounts, so a
    // transferred number cannot be assigned to two active connections.
    const phones = selectedNumbers.map((number) => number.phoneNumber).sort();
    for (const phone of phones)
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `twilio:number:${phone}`,
      ]);
    const overlap = await client.query(
      `SELECT 1 FROM provider_connections c JOIN connection_numbers n ON n.connection_id = c.id
      WHERE c.provider = 'twilio' AND n.phone_number = ANY($1::text[]) LIMIT 1`,
      [phones],
    );
    if (overlap.rows.length)
      throw new Error(
        "One or more numbers are already connected. Each number can belong to only one workspace.",
      );
    await client.query(
      `INSERT INTO provider_connections (id, workspace_id, provider, name, account_sid, encrypted_credentials, twiml_app_sid)
      VALUES ($1, $2, 'twilio', $3, $4, $5::jsonb, $6)`,
      [
        connectionId,
        workspaceId,
        name.trim(),
        credentials.accountSid,
        JSON.stringify(envelope),
        credentials.twimlAppSid,
      ],
    );
    for (const number of selectedNumbers) {
      await client.query(
        `INSERT INTO connection_numbers (id, connection_id, provider_number_sid, phone_number, voice_enabled, sms_enabled)
        VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          randomUUID(),
          connectionId,
          number.sid,
          number.phoneNumber,
          number.voice,
          number.sms,
        ],
      );
    }
    await client.query(
      `INSERT INTO connection_sync_checkpoints (connection_id, stream, synced_through)
      VALUES ($1, 'calls', now() - interval '1 day'), ($1, 'messages', now() - interval '1 day')`,
      [connectionId],
    );
    await client.query("COMMIT");
    return {
      id: connectionId,
      workspace_id: workspaceId,
      provider: "twilio",
      name: name.trim(),
      account_sid: credentials.accountSid,
      numbers: selectedNumbers,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  inTransaction,
  listWorkspaces,
  listVoiceTargets,
  createWorkspace,
  renameWorkspace,
  archiveWorkspace,
  releaseNumber,
  moveNumber,
  updateNumberSettings,
  setNumberAssignees,
  listAllConnections,
  listConnections,
  createConnection,
  selectNumber,
  selectLegacy,
  updateConnectionCredentials,
  previewConnectionNumbers,
  addConnectionNumbers,
};
