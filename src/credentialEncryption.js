const crypto = require("crypto");

function keyFromEnvironment() {
  const encoded = process.env.WORKSPACE_CREDENTIALS_KEY || "";
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
    throw new Error(
      "WORKSPACE_CREDENTIALS_KEY must be a base64-encoded 32-byte key",
    );
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    throw new Error(
      "WORKSPACE_CREDENTIALS_KEY must be a base64-encoded 32-byte key",
    );
  }
  return key;
}

function encryptCredentials(connectionId, credentials) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFromEnvironment(), iv);
  cipher.setAAD(Buffer.from(`twilio-connection:v1:${connectionId}`, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credentials), "utf8"),
    cipher.final(),
  ]);
  return {
    version: 1,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptCredentials(connectionId, envelope) {
  if (!envelope || envelope.version !== 1)
    throw new Error("Unsupported credential envelope");
  const iv = Buffer.from(envelope.iv || "", "base64");
  const tag = Buffer.from(envelope.tag || "", "base64");
  if (iv.length !== 12 || tag.length !== 16)
    throw new Error("Invalid credential envelope");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    keyFromEnvironment(),
    iv,
  );
  decipher.setAAD(Buffer.from(`twilio-connection:v1:${connectionId}`, "utf8"));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext || "", "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

module.exports = { encryptCredentials, decryptCredentials };
