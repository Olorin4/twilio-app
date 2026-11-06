const { randomUUID } = require("crypto");
const pool = require("./db");
const {
  encryptCredentials,
  decryptCredentials,
} = require("./credentialEncryption");
const { validateTwilioConnection } = require("./twilioConnectionValidation");
const { IRON_WING_WORKSPACE_ID } = require("./workspaceContext");

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function listWorkspaces() {
  const result = await pool.query(
    `SELECT w.id, w.name, w.created_at, n.id AS active_number_id,
      c.id AS active_connection_id, COALESCE(n.phone_number, CASE WHEN w.id = $1::uuid THEN $2::text ELSE NULL END) AS active_phone,
      n.voice_enabled AS active_voice_enabled, n.sms_enabled AS active_sms_enabled
     FROM workspaces w LEFT JOIN workspace_active_numbers a ON a.workspace_id = w.id
     LEFT JOIN connection_numbers n ON n.id = a.connection_number_id
     LEFT JOIN provider_connections c ON c.id = n.connection_id AND c.workspace_id = w.id
     ORDER BY lower(w.name), w.id`,
    [IRON_WING_WORKSPACE_ID, process.env.TWILIO_CALLER_ID || null],
  );
  return result.rows;
}
async function listVoiceTargets() {
  const result =
    await pool.query(`SELECT DISTINCT ON (c.id) c.id AS connection_id, w.id AS workspace_id, w.name AS workspace_name,
      n.id AS number_id, n.phone_number
    FROM provider_connections c JOIN workspaces w ON w.id = c.workspace_id
    JOIN connection_numbers n ON n.connection_id = c.id
    LEFT JOIN workspace_active_numbers a ON a.workspace_id = w.id
    WHERE n.voice_enabled = true
    ORDER BY c.id, (a.connection_number_id = n.id) DESC NULLS LAST, n.id`);
  const targets = result.rows;
  if (process.env.TWILIO_CALLER_ID) {
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
  if (typeof name !== "string" || !name.trim() || name.trim().length > 120)
    throw new Error("Enter a workspace name of up to 120 characters.");
  const result = await pool.query(
    "INSERT INTO workspaces (id, name) VALUES ($1, $2) RETURNING id, name, created_at",
    [randomUUID(), name.trim()],
  );
  return result.rows[0];
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
      (a.connection_number_id = n.id) AS active
    FROM connection_numbers n JOIN provider_connections c ON c.id = n.connection_id
    LEFT JOIN workspace_active_numbers a ON a.workspace_id = c.workspace_id
    WHERE c.workspace_id = $1 ORDER BY n.phone_number`,
    [workspaceId],
  );
  return result.rows.map((row) => ({
    ...row,
    numbers: numbers.rows.filter((number) => number.connection_id === row.id),
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
  if (selected.some((number) => legacyNumbers.includes(number.phoneNumber)))
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
  listWorkspaces,
  listVoiceTargets,
  createWorkspace,
  listConnections,
  createConnection,
  selectNumber,
  selectLegacy,
  updateConnectionCredentials,
  previewConnectionNumbers,
  addConnectionNumbers,
};
