const { Router } = require("express");
const { randomUUID } = require("crypto");
const pool = require("./db");
const { IRON_WING_WORKSPACE_ID } = require("./workspaceContext");
const workspaceId = (req) => req.workspace?.id || IRON_WING_WORKSPACE_ID;

const router = Router();
const columns =
  "id, name, phone, company, email, notes, created_at, updated_at";
const idPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return { error: "Enter contact details." };
  const limits = {
    name: 120,
    phone: 32,
    company: 120,
    email: 254,
    notes: 2000,
  };
  const values = {};
  for (const [key, max] of Object.entries(limits)) {
    if (body[key] !== undefined && typeof body[key] !== "string")
      return { error: `Invalid ${key}.` };
    values[key] = (body[key] || "").trim();
    if (values[key].length > max) return { error: `${key} is too long.` };
  }
  values.phone = values.phone.replace(/[\s().-]/g, "");
  if (!values.name) return { error: "Name is required." };
  if (!/^\+[1-9]\d{7,14}$/.test(values.phone))
    return {
      error:
        "Enter a phone number with its country code, such as +15551234567.",
    };
  if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email))
    return { error: "Enter a valid email address." };
  return { values };
}

function sendError(res, error) {
  if (error.code === "42P01")
    return res
      .status(503)
      .json({ error: "Contacts storage is not set up yet." });
  console.error("Contacts operation failed:", error.message);
  return res.status(500).json({ error: "Could not save or load contacts." });
}

router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ${columns} FROM phone_contacts WHERE workspace_id = $1 ORDER BY lower(name), id`,
      [workspaceId(req)],
    );
    return res.json(result.rows);
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/", async (req, res) => {
  if (!req.is("application/json"))
    return res.status(415).json({ error: "JSON is required." });
  const { values, error } = validate(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const result = await pool.query(
      `INSERT INTO phone_contacts (id, name, phone, company, email, notes, workspace_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${columns}`,
      [
        randomUUID(),
        values.name,
        values.phone,
        values.company,
        values.email,
        values.notes,
        workspaceId(req),
      ],
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    return sendError(res, err);
  }
});

router.put("/:id", async (req, res) => {
  if (!idPattern.test(req.params.id))
    return res.status(400).json({ error: "Invalid contact ID." });
  if (!req.is("application/json"))
    return res.status(415).json({ error: "JSON is required." });
  const { values, error } = validate(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const result = await pool.query(
      `UPDATE phone_contacts SET name = $2, phone = $3, company = $4, email = $5, notes = $6, updated_at = now() WHERE id = $1 AND workspace_id = $7 RETURNING ${columns}`,
      [
        req.params.id,
        values.name,
        values.phone,
        values.company,
        values.email,
        values.notes,
        workspaceId(req),
      ],
    );
    return result.rows.length
      ? res.json(result.rows[0])
      : res.status(404).json({ error: "Contact not found." });
  } catch (err) {
    return sendError(res, err);
  }
});

router.delete("/:id", async (req, res) => {
  if (!idPattern.test(req.params.id))
    return res.status(400).json({ error: "Invalid contact ID." });
  try {
    const result = await pool.query(
      "DELETE FROM phone_contacts WHERE id = $1 AND workspace_id = $2 RETURNING id",
      [req.params.id, workspaceId(req)],
    );
    return result.rows.length
      ? res.sendStatus(204)
      : res.status(404).json({ error: "Contact not found." });
  } catch (error) {
    return sendError(res, error);
  }
});

module.exports = router;
module.exports.validate = validate;
