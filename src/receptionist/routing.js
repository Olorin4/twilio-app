/* Decides, for one inbound call, whether an AI agent answers or the call
follows today's path (ring the softphone, or an announcement). */

const pool = require("../db");
const store = require("./store");
const { getAssistantSettings } = require("../assistantSettings");
const { getProfile, getDefaultProfile } = require("../agentProfiles");
const { callableNumber } = require("./phone");
const { IRON_WING_WORKSPACE_ID } = require("../workspaceContext");

// The agent profile that should answer a call to this number, or null for
// today's path. The legacy /voice route (no provider, or the legacy provider)
// is answered by Iron Wing's default profile. A connection number is answered
// only when it is set to an AI agent whose profile still exists in the
// number's own workspace: a profile that was deleted, or a number that moved
// to another workspace, gives null rather than the wrong business's agent.
async function resolveProfile(provider) {
  if (!provider || provider.legacy || provider.handler === "legacy")
    return getDefaultProfile(IRON_WING_WORKSPACE_ID);
  if (provider.handler !== "ai_agent" || !provider.agentProfileId) return null;
  const profile = await getProfile(provider.agentProfileId);
  if (!profile || profile.workspaceId !== provider.workspaceId) return null;
  return profile;
}

// `provider` is undefined on the legacy /voice route, or the object from
// getProviderForWebhook on a connection route. `profile` is what
// resolveProfile gave for it.
async function decideRoute({ from, to, provider, config, profile }) {
  const no = (reason) => ({ agent: false, reason });
  if (!config.enabled) return no("disabled");
  if (typeof from === "string" && from.startsWith("client:"))
    return no("outgoing");
  const publicNumber = provider?.phoneNumber || require("../token").callerId;
  if (!to || to !== publicNumber) return no("not_public_number");
  if (!profile) return no("no_agent");
  // resolveProfile already checks this; repeated so a profile from another
  // business can never answer this number.
  const workspaceId = provider?.workspaceId || IRON_WING_WORKSPACE_ID;
  if (profile.workspaceId !== workspaceId) return no("no_agent");
  if (!profile.enabled) return no("profile_disabled");
  // The workspace switch belongs to the workspace's default agent (Jack for
  // Iron Wing); other profiles have their own enabled flag.
  if (profile.isDefault && !(await getAssistantSettings(workspaceId)).jack)
    return no("workspace_disabled");

  // A blocked or missing caller ID still gets the agent, which then asks for
  // a callback number.
  const caller = typeof from === "string" && from ? from : "anonymous";
  // Test callers skip every later check so the owner can call in repeatedly
  // from a saved number while tuning.
  if (config.testCallers.has(caller))
    return { agent: true, reason: "test_caller" };
  if (config.testMode) return no("test_mode");

  // A saved contact is someone the business already knows, so a receptionist
  // hands them to a person. Dispatcher and support lines exist to take those
  // very callers.
  if (profile.kind === "receptionist" && callableNumber(caller)) {
    const contact = await pool.query(
      "SELECT 1 FROM phone_contacts WHERE workspace_id = $1 AND phone = $2 LIMIT 1",
      [workspaceId, caller],
    );
    if (contact.rows.length) return no("contact");
  }
  const limit = profile.dailyLimit ?? config.dailyLimit;
  if ((await store.countAgentCalls(caller, profile.id)) >= limit)
    return no("limit");
  return { agent: true, reason: "ok" };
}

module.exports = { decideRoute, resolveProfile };
