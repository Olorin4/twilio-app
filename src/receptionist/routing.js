/* Decides, for one inbound call, whether the AI receptionist answers or the
call follows today's path (ring the softphone, or an announcement). */

const pool = require("../db");
const store = require("./store");
const { getAssistantSettings } = require("../assistantSettings");
const { callableNumber } = require("./phone");
const { IRON_WING_WORKSPACE_ID } = require("../workspaceContext");

// `provider` is undefined on the legacy /voice route, or the object from
// getProviderForWebhook on a connection route.
async function decideRoute({ from, to, provider, config }) {
  const no = (reason) => ({ agent: false, reason });
  if (!config.enabled) return no("disabled");
  if (typeof from === "string" && from.startsWith("client:"))
    return no("outgoing");
  const publicNumber = provider?.phoneNumber || require("../token").callerId;
  if (!to || to !== publicNumber) return no("not_public_number");
  if (provider && provider.workspaceId !== IRON_WING_WORKSPACE_ID)
    return no("not_iron_wing");
  if (!(await getAssistantSettings(IRON_WING_WORKSPACE_ID)).jack)
    return no("workspace_disabled");

  // A blocked or missing caller ID still gets the agent, which then asks for
  // a callback number.
  const caller = typeof from === "string" && from ? from : "anonymous";
  // Test callers skip every later check so the owner can call in repeatedly
  // from a saved number while tuning.
  if (config.testCallers.has(caller))
    return { agent: true, reason: "test_caller" };
  if (config.testMode) return no("test_mode");

  if (callableNumber(caller)) {
    const contact = await pool.query(
      "SELECT 1 FROM phone_contacts WHERE workspace_id = $1 AND phone = $2 LIMIT 1",
      [IRON_WING_WORKSPACE_ID, caller],
    );
    if (contact.rows.length) return no("contact");
  }
  if ((await store.countAgentCalls(caller)) >= config.dailyLimit)
    return no("limit");
  return { agent: true, reason: "ok" };
}

module.exports = { decideRoute };
