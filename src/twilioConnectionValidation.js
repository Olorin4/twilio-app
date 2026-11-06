const twilio = require("twilio");

function validateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  return (
    /^AC[0-9a-f]{32}$/i.test(input.accountSid || "") &&
    /^SK[0-9a-f]{32}$/i.test(input.apiKeySid || "") &&
    /^AP[0-9a-f]{32}$/i.test(input.twimlAppSid || "") &&
    typeof input.authToken === "string" &&
    input.authToken.length > 0 &&
    input.authToken.length <= 256 &&
    typeof input.apiKeySecret === "string" &&
    input.apiKeySecret.length > 0 &&
    input.apiKeySecret.length <= 256
  );
}

async function validateTwilioConnection(input, makeClient = twilio) {
  if (!validateInput(input)) throw new Error("Enter valid Twilio credentials.");
  const accountClient = makeClient(input.accountSid, input.authToken);
  const apiKeyClient = makeClient(input.apiKeySid, input.apiKeySecret, {
    accountSid: input.accountSid,
  });
  try {
    // These are read-only requests. In particular, they do not change routing,
    // purchase numbers, create messages or place calls.
    await accountClient.incomingPhoneNumbers.list({ limit: 1 });
    const application = await apiKeyClient
      .applications(input.twimlAppSid)
      .fetch();
    const numbers = [];
    let page = await apiKeyClient.incomingPhoneNumbers.page({ pageSize: 100 });
    while (page) {
      for (const item of page.instances) {
        numbers.push({
          sid: item.sid,
          phoneNumber: item.phoneNumber,
          friendlyName: item.friendlyName,
          voice: Boolean(item.capabilities?.voice),
          sms: Boolean(item.capabilities?.sms),
        });
      }
      page = await page.nextPage();
    }
    return {
      application: {
        sid: application.sid,
        friendlyName: application.friendlyName,
      },
      numbers,
    };
  } catch {
    // Avoid logging or returning provider errors, which may contain request
    // details. The prior connection remains untouched on validation failure.
    throw new Error(
      "Could not verify the Twilio credentials and resources. Check the credentials and permissions.",
    );
  }
}
module.exports = { validateInput, validateTwilioConnection };
