const crypto = require("crypto");
const {
  encryptCredentials,
  decryptCredentials,
} = require("../src/credentialEncryption");

const originalKey = process.env.WORKSPACE_CREDENTIALS_KEY;
beforeEach(() => {
  process.env.WORKSPACE_CREDENTIALS_KEY = crypto
    .randomBytes(32)
    .toString("base64");
});
afterAll(() => {
  if (originalKey === undefined) delete process.env.WORKSPACE_CREDENTIALS_KEY;
  else process.env.WORKSPACE_CREDENTIALS_KEY = originalKey;
});

test("encrypts credentials with a fresh nonce and decrypts only for their connection", () => {
  const secrets = { authToken: "secret-auth", apiSecret: "secret-api" };
  const first = encryptCredentials("connection-a", secrets);
  const second = encryptCredentials("connection-a", secrets);
  expect(first.iv).not.toBe(second.iv);
  expect(JSON.stringify(first)).not.toContain("secret-auth");
  expect(decryptCredentials("connection-a", first)).toEqual(secrets);
  expect(() => decryptCredentials("connection-b", first)).toThrow();
});
test("rejects tampering and missing or invalid encryption keys", () => {
  const envelope = encryptCredentials("connection-a", { secret: "value" });
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  ciphertext[0] ^= 1;
  expect(() =>
    decryptCredentials("connection-a", {
      ...envelope,
      ciphertext: ciphertext.toString("base64"),
    }),
  ).toThrow();
  delete process.env.WORKSPACE_CREDENTIALS_KEY;
  expect(() => encryptCredentials("connection-a", {})).toThrow(
    "WORKSPACE_CREDENTIALS_KEY",
  );
  process.env.WORKSPACE_CREDENTIALS_KEY = "not-a-key";
  expect(() => decryptCredentials("connection-a", envelope)).toThrow(
    "WORKSPACE_CREDENTIALS_KEY",
  );
});
