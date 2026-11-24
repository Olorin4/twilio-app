const pool = require("./db");

const IRON_WING_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Owners open every workspace; members only those they are a member of.
function canOpenWorkspace(user, workspaceId) {
  if (!user) return false;
  if (user.role === "owner") return true;
  if (user.role !== "member" || !Array.isArray(user.workspaceIds)) return false;
  const id = String(workspaceId).toLowerCase();
  return user.workspaceIds.some((own) => String(own).toLowerCase() === id);
}

// Picks the request's workspace (X-Workspace-Id, else Iron Wing) and refuses
// one req.user can't open with the same 404 as an unknown workspace. A member
// without Iron Wing gets that 404 for an absent header too, never a fallback.
async function resolveWorkspace(req, res, next) {
  const supplied = req.get("X-Workspace-Id");
  const id = supplied === undefined ? IRON_WING_WORKSPACE_ID : supplied;
  if (!uuidPattern.test(id))
    return res.status(400).json({ error: "Invalid workspace." });
  if (!canOpenWorkspace(req.user, id))
    return res.status(404).json({ error: "Workspace not found." });
  try {
    const result = await pool.query(
      "SELECT id, name FROM workspaces WHERE id = $1 AND archived_at IS NULL",
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
module.exports = { IRON_WING_WORKSPACE_ID, canOpenWorkspace, resolveWorkspace };
