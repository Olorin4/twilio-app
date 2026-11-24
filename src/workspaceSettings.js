const { Router } = require("express");
const {
  listWorkspaces,
  listVoiceTargets,
  createWorkspace,
  renameWorkspace,
  archiveWorkspace,
  releaseNumber,
  moveNumber,
  listAllConnections,
  listConnections,
  createConnection,
  selectNumber,
  selectLegacy,
  updateConnectionCredentials,
  previewConnectionNumbers,
  addConnectionNumbers,
} = require("./workspaceConnections");
const { validateTwilioConnection } = require("./twilioConnectionValidation");
const {
  resolveWorkspace,
  IRON_WING_WORKSPACE_ID,
} = require("./workspaceContext");
const {
  getAssistantSettings,
  updateAssistantSettings,
} = require("./assistantSettings");
const { getConfig: receptionistConfig } = require("./receptionist/config");
const {
  config: callAssistConfig,
  available: callAssistAvailable,
} = require("./callAssist/config");
const router = Router();
router.get("/config", (req, res) =>
  res.json({
    webhookBaseUrl: (process.env.TWILIO_WEBHOOK_BASE_URL || "").replace(
      /\/$/,
      "",
    ),
    legacyPhoneNumber: process.env.TWILIO_CALLER_ID || "",
    legacyAccountSid: process.env.TWILIO_ACCOUNT_SID || "",
  }),
);

function requireSettingsWrite(req, res, next) {
  if (!req.is("application/json"))
    return res.status(415).json({ error: "JSON is required." });
  const origin = req.get("Origin");
  const permitted = [
    process.env.TWILIO_WEBHOOK_BASE_URL,
    process.env.APP_ORIGIN,
  ]
    .filter(Boolean)
    .map((value) => {
      try {
        return new URL(value).origin;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (!origin || !permitted.includes(origin))
    return res.status(403).json({ error: "Invalid request origin." });
  return next();
}

function publicError(res, error) {
  const message = error.message || "";
  if (message.startsWith("WORKSPACE_CREDENTIALS_KEY"))
    return res
      .status(503)
      .json({ error: "Connection storage is not configured." });
  if (
    [
      "Invalid workspace.",
      "Workspace does not exist.",
      "The Iron Wing workspace cannot be archived.",
      "Choose a different connection.",
      "Connection does not exist.",
      "To move a number to another Twilio account",
      "Enter a workspace name",
      "Enter a connection name",
      "Enter valid Twilio credentials.",
      "Could not verify the Twilio credentials",
      "Select at least one owned",
      "A selected number does not belong",
      "The current Iron Wing number",
      "The existing Iron Wing TwiML App",
      "One or more numbers are already connected",
      "Invalid workspace or number.",
      "Number does not belong to this workspace.",
      "The environment connection is only available",
      "Invalid workspace or connection.",
      "Connection does not exist in this workspace.",
      "To use a different Twilio account",
      "The updated account no longer owns",
      "Connection changed while validating",
    ].some((prefix) => message.startsWith(prefix))
  )
    return res.status(400).json({ error: message });
  if (error.code === "23505")
    return res.status(409).json({
      error:
        "The account, TwiML App, or number is already assigned to a connection.",
    });
  console.error(
    "Workspace settings operation failed:",
    error.code || "unknown",
  );
  return res
    .status(500)
    .json({ error: "Could not update workspace settings." });
}

function assistantState(workspace, preferences) {
  return {
    preferences,
    available: {
      jack:
        workspace === IRON_WING_WORKSPACE_ID && receptionistConfig().enabled,
      liveAssist: callAssistAvailable(callAssistConfig()),
    },
  };
}

router.get("/assist", resolveWorkspace, async (req, res) => {
  try {
    return res.json(
      assistantState(
        req.workspace.id,
        await getAssistantSettings(req.workspace.id),
      ),
    );
  } catch (error) {
    return publicError(res, error);
  }
});

router.patch(
  "/assist",
  requireSettingsWrite,
  resolveWorkspace,
  async (req, res) => {
    const entries = Object.entries(req.body || {});
    if (
      !entries.length ||
      entries.some(
        ([key, value]) =>
          !["jack", "liveAssist"].includes(key) || typeof value !== "boolean",
      )
    )
      return res.status(400).json({ error: "Enter valid assistant settings." });
    try {
      return res.json(
        assistantState(
          req.workspace.id,
          await updateAssistantSettings(req.workspace.id, req.body),
        ),
      );
    } catch (error) {
      return publicError(res, error);
    }
  },
);

router.get("/workspaces", async (req, res) => {
  try {
    return res.json(await listWorkspaces());
  } catch (error) {
    return publicError(res, error);
  }
});
router.get("/voice-targets", async (req, res) => {
  try {
    return res.json(await listVoiceTargets());
  } catch (error) {
    return publicError(res, error);
  }
});
router.post("/workspaces", requireSettingsWrite, async (req, res) => {
  try {
    return res.status(201).json(await createWorkspace(req.body?.name));
  } catch (error) {
    return publicError(res, error);
  }
});
router.patch(
  "/workspaces/:workspaceId",
  requireSettingsWrite,
  async (req, res) => {
    try {
      return res.json(
        await renameWorkspace(req.params.workspaceId, req.body?.name),
      );
    } catch (error) {
      return publicError(res, error);
    }
  },
);
router.delete(
  "/workspaces/:workspaceId",
  requireSettingsWrite,
  async (req, res) => {
    try {
      return res.json(await archiveWorkspace(req.params.workspaceId));
    } catch (error) {
      return publicError(res, error);
    }
  },
);
router.get("/workspaces/:workspaceId/connections", async (req, res) => {
  try {
    return res.json(await listConnections(req.params.workspaceId));
  } catch (error) {
    return publicError(res, error);
  }
});
router.get("/connections", async (req, res) => {
  try {
    return res.json(await listAllConnections());
  } catch (error) {
    return publicError(res, error);
  }
});
router.post(
  "/workspaces/:workspaceId/numbers/:numberId/release",
  requireSettingsWrite,
  async (req, res) => {
    try {
      return res.json(
        await releaseNumber(req.params.workspaceId, req.params.numberId),
      );
    } catch (error) {
      return publicError(res, error);
    }
  },
);
router.post(
  "/workspaces/:workspaceId/numbers/:numberId/move",
  requireSettingsWrite,
  async (req, res) => {
    try {
      return res.json(
        await moveNumber(
          req.params.workspaceId,
          req.params.numberId,
          req.body?.connectionId,
        ),
      );
    } catch (error) {
      return publicError(res, error);
    }
  },
);
router.post("/connections/validate", requireSettingsWrite, async (req, res) => {
  try {
    return res.json(await validateTwilioConnection(req.body));
  } catch (error) {
    return publicError(res, error);
  }
});
router.post(
  "/workspaces/:workspaceId/connections",
  requireSettingsWrite,
  async (req, res) => {
    try {
      const { name, credentials, selectedNumberSids } = req.body || {};
      const result = await createConnection(
        req.params.workspaceId,
        name,
        credentials,
        { selectedNumberSids },
      );
      return res.status(201).json(result);
    } catch (error) {
      return publicError(res, error);
    }
  },
);
router.post(
  "/workspaces/:workspaceId/legacy-number",
  requireSettingsWrite,
  async (req, res) => {
    try {
      return res.json(await selectLegacy(req.params.workspaceId));
    } catch (error) {
      return publicError(res, error);
    }
  },
);
router.post(
  "/workspaces/:workspaceId/active-number",
  requireSettingsWrite,
  async (req, res) => {
    try {
      return res.json(
        await selectNumber(req.params.workspaceId, req.body?.numberId),
      );
    } catch (error) {
      return publicError(res, error);
    }
  },
);

router.post(
  "/workspaces/:workspaceId/connections/:connectionId/numbers/validate",
  requireSettingsWrite,
  async (req, res) => {
    try {
      return res.json(
        await previewConnectionNumbers(
          req.params.workspaceId,
          req.params.connectionId,
        ),
      );
    } catch (error) {
      return publicError(res, error);
    }
  },
);
router.post(
  "/workspaces/:workspaceId/connections/:connectionId/numbers",
  requireSettingsWrite,
  async (req, res) => {
    try {
      return res.json(
        await addConnectionNumbers(
          req.params.workspaceId,
          req.params.connectionId,
          req.body?.selectedNumberSids,
        ),
      );
    } catch (error) {
      return publicError(res, error);
    }
  },
);
router.put(
  "/workspaces/:workspaceId/connections/:connectionId",
  requireSettingsWrite,
  async (req, res) => {
    try {
      return res.json(
        await updateConnectionCredentials(
          req.params.workspaceId,
          req.params.connectionId,
          req.body?.credentials,
        ),
      );
    } catch (error) {
      return publicError(res, error);
    }
  },
);
module.exports = router;
module.exports.requireSettingsWrite = requireSettingsWrite;
