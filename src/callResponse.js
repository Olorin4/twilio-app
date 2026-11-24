/* callResponse.js is responsible for handling incoming calls, messages, faxes and logs
and then exporting them for use in router.js. */

const VoiceResponse = require("twilio").twiml.VoiceResponse;
const { callerId, getIdentity } = require("./token");
const { IRON_WING_WORKSPACE_ID } = require("./workspaceContext");
const { getConfig, isOpen, sayOptions } = require("./receptionist/config");

// Debugging twilio credentials imports
// console.log("✔ Debugging handler.js credentials:");
// if (!callerId) throw new Error("Caller ID is missing in Twilio configuration.");
console.log("✔ Twilio credentials correctly imported into handler.js");

// Handle Incoming Calls. `ringIdentities` (src/ringing.js) lists the
// softphones an inbound call rings; without one, it rings the identity used
// before user accounts existed, so a line never rings nobody.
exports.voiceResponse = function voiceResponse(
  requestBody,
  provider,
  ringIdentities,
) {
  const toNumberOrClientName = requestBody.To;
  console.log("📞 Incoming call to:", requestBody.To);
  let twiml = new VoiceResponse();

  const connectionCallerId = provider?.phoneNumber || callerId;
  const isIronWing =
    !provider || provider.workspaceId === IRON_WING_WORKSPACE_ID;
  const bootstrapIdentity =
    provider && !provider.legacy
      ? `connection_${provider.id.replace(/-/g, "")}`
      : getIdentity();
  const listed = Array.isArray(ringIdentities)
    ? [...new Set(ringIdentities.filter(Boolean))]
    : [];
  const identities = listed.length
    ? listed
    : bootstrapIdentity
      ? [bootstrapIdentity]
      : [];
  const identity = identities[0];
  const callbackBase = (process.env.TWILIO_WEBHOOK_BASE_URL || "").replace(
    /\/$/,
    "",
  );
  const callbackOptions = callbackBase
    ? {
        statusCallback:
          callbackBase +
          (provider && !provider.legacy
            ? `/webhooks/${provider.id}/call-status`
            : "/call-status"),
        statusCallbackEvent: "initiated ringing answered completed",
        statusCallbackMethod: "POST",
      }
    : {};
  const announcementBase = callbackBase
    ? callbackBase +
      (provider && !provider.legacy
        ? `/webhooks/${provider.id}/announcement`
        : "/announcement")
    : "";
  console.log(`🔍 [DEBUG] Dialing clients: ${identities.join(", ")}`);

  if (
    isIronWing &&
    (provider?.observeHours ?? true) &&
    toNumberOrClientName == connectionCallerId &&
    !isOpen(new Date(), getConfig().hours)
  ) {
    // If the call is outside business hours, play the closed message
    console.log("🟠 [DEBUG] Outside business hours. Playing closed message.");
    if (announcementBase) twiml.redirect(`${announcementBase}/closed`);
    else
      twiml.say(
        sayOptions(),
        "Hello! Thank you for calling Iron Wing Dispatching. Our office is currently closed. Please call back during business hours.",
      );
  } else if (toNumberOrClientName == connectionCallerId) {
    // Call is within business hours, attempt to connect to the client
    console.log("🟢 [DEBUG] Attempting to route call to browser-client...");
    if (identity) {
      let dial = twiml.dial({
        timeout: 20,
        ...(announcementBase ? { action: `${announcementBase}/missed` } : {}),
      });
      // One <Dial>, so the first softphone to answer takes the call.
      for (const ringing of identities) {
        if (provider && !provider.legacy) {
          const target = dial.client(callbackOptions);
          target.identity(ringing);
          target.parameter({ name: "CalledNumber", value: connectionCallerId });
          if (provider.numberLabel)
            target.parameter({
              name: "CalledLabel",
              value: provider.numberLabel,
            });
        } else dial.client(callbackOptions, ringing);
      }
    }

    // **This message only plays if no one answers within 20 seconds**
    if (!announcementBase || !identity) {
      twiml.say(
        sayOptions(),
        isIronWing
          ? "Hello! Thank you for calling Iron Wing Dispatching. One of our representatives will call you back soon."
          : "Hello! Thank you for calling. One of our representatives will call you back soon.",
      );
    }
  } else if (requestBody.To) {
    // Outgoing call logic
    let dial = twiml.dial({ callerId: connectionCallerId });
    const attr = isAValidPhoneNumber(toNumberOrClientName)
      ? "number"
      : "client";
    dial[attr](callbackOptions, toNumberOrClientName);
  }

  console.log("📞 Generated TwiML:", twiml.toString());
  return twiml.toString();
};

/**
 * Checks if the given value is valid as phone number
 * @param {Number|String} number
 * @return {Boolean}
 */
function isAValidPhoneNumber(number) {
  return /^[\d()+ -]+$/.test(number);
}
//
