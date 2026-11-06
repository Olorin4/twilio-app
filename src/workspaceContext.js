const pool = require("./db");

const IRON_WING_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// This identifies a workspace for a single authenticated operator. It is not
// an authorization check and must not be used as tenant isolation.
async function resolveWorkspace(req, res, next) {
  const supplied = req.get("X-Workspace-Id");
  const id = supplied === undefined ? IRON_WING_WORKSPACE_ID : supplied;
  if (!uuidPattern.test(id))
    return res.status(400).json({ error: "Invalid workspace." });
  try {
    const result = await pool.query(
      "SELECT id, name FROM workspaces WHERE id = $1",
      [id],
    );
    if (!result.rows.length)
      return res.status(404).json({ error: "Workspace not found." });
    req.workspace = result.rows[0];
    return next();
  } catch (error) {
    console.error("Workspace lookup failed:", error.message);
    return res.status(503).json({ error: "Could not load workspace." });
  }
}
module.exports = { IRON_WING_WORKSPACE_ID, resolveWorkspace };
