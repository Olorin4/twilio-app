const pool = require("./db");

const defaults = { jack: true, liveAssist: true };

function preferences(row) {
  return row
    ? { jack: row.jack_enabled, liveAssist: row.live_assist_enabled }
    : defaults;
}

async function getAssistantSettings(workspace) {
  try {
    const {
      rows: [row],
    } = await pool.query(
      `SELECT jack_enabled, live_assist_enabled FROM workspace_assistant_settings
       WHERE workspace_id = $1`,
      [workspace],
    );
    return preferences(row);
  } catch (error) {
    // Preserve the pre-migration routing behavior during an additive release.
    if (error.code === "42P01") return defaults;
    throw error;
  }
}

async function updateAssistantSettings(workspace, patch) {
  const {
    rows: [row],
  } = await pool.query(
    `INSERT INTO workspace_assistant_settings (workspace_id, jack_enabled, live_assist_enabled)
     VALUES ($1, COALESCE($2, true), COALESCE($3, true))
     ON CONFLICT (workspace_id) DO UPDATE SET
       jack_enabled = COALESCE($2, workspace_assistant_settings.jack_enabled),
       live_assist_enabled = COALESCE($3, workspace_assistant_settings.live_assist_enabled)
     RETURNING jack_enabled, live_assist_enabled`,
    [workspace, patch.jack ?? null, patch.liveAssist ?? null],
  );
  return preferences(row);
}

module.exports = { getAssistantSettings, updateAssistantSettings };
