const {
  validateTwilioConnection,
} = require("../src/twilioConnectionValidation");
const input = {
  accountSid: "AC" + "1".repeat(32),
  authToken: "test-auth",
  apiKeySid: "SK" + "2".repeat(32),
  apiKeySecret: "test-secret",
  twimlAppSid: "AP" + "3".repeat(32),
};
test("validates both credentials and collects owned numbers across all pages", async () => {
  const last = {
    instances: [
      {
        sid: "PN2",
        phoneNumber: "+15550000002",
        capabilities: { voice: true, sms: false },
      },
    ],
    nextPage: jest.fn().mockResolvedValue(undefined),
  };
  const first = {
    instances: [
      {
        sid: "PN1",
        phoneNumber: "+15550000001",
        capabilities: { voice: true, sms: true },
      },
    ],
    nextPage: jest.fn().mockResolvedValue(last),
  };
  const authClient = {
    incomingPhoneNumbers: { list: jest.fn().mockResolvedValue([]) },
  };
  const keyClient = {
    applications: jest.fn().mockReturnValue({
      fetch: jest.fn().mockResolvedValue({ sid: input.twimlAppSid }),
    }),
    incomingPhoneNumbers: { page: jest.fn().mockResolvedValue(first) },
  };
  const makeClient = jest
    .fn()
    .mockReturnValueOnce(authClient)
    .mockReturnValueOnce(keyClient);
  const result = await validateTwilioConnection(input, makeClient);
  expect(makeClient).toHaveBeenNthCalledWith(
    2,
    input.apiKeySid,
    input.apiKeySecret,
    { accountSid: input.accountSid },
  );
  expect(result.numbers).toHaveLength(2);
  expect(result.numbers[1].sms).toBe(false);
  expect(JSON.stringify(result)).not.toContain(input.authToken);
});
test("fails closed without leaking provider errors", async () => {
  const makeClient = jest.fn().mockReturnValue({
    incomingPhoneNumbers: {
      list: jest.fn().mockRejectedValue(new Error("private provider details")),
    },
  });
  await expect(validateTwilioConnection(input, makeClient)).rejects.toThrow(
    "Could not verify",
  );
  await expect(
    validateTwilioConnection({ ...input, accountSid: "invalid" }, makeClient),
  ).rejects.toThrow("valid Twilio credentials");
});
