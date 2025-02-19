require("dotenv").config();

const config = {
  production: {
    SERVER_IP: process.env.SERVER_IP,
    PORT: process.env.PORT || 3001,
    API_URL: process.env.API_URL,

    // Twilio Credentials
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
    TWILIO_TWIML_APP_SID: process.env.TWILIO_TWIML_APP_SID,
    TWILIO_API_KEY: process.env.TWILIO_API_KEY,
    TWILIO_API_SECRET: process.env.TWILIO_API_SECRET,
    TWILIO_CALLER_ID: process.env.TWILIO_CALLER_ID,

    // Database Credentials
    DB_USER: process.env.DB_USER,
    DB_HOST: process.env.DB_HOST,
    DB_NAME: process.env.DB_NAME,
    DB_PASS: process.env.DB_PASS,
    DB_PORT: process.env.DB_PORT || 5432,
  },

  development: {
    LOCAL_SERVER_IP: "localhost",
    LOCAL_PORT: 4001,
    LOCAL_API_URL: "http://localhost:4001",

    // Local Twilio Credentials
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || "",
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || "",
    TWILIO_TWIML_APP_SID: process.env.TWILIO_TWIML_APP_SID || "",
    TWILIO_API_KEY: process.env.TWILIO_API_KEY || "",
    TWILIO_API_SECRET: process.env.TWILIO_API_SECRET || "",
    TWILIO_CALLER_ID: process.env.TWILIO_CALLER_ID || "",

    // Local Database Credentials
    API_URL: process.env.LOCAL_API_URL,
    DB_USER: process.env.LOCAL_DB_USER,
    DB_HOST: process.env.LOCAL_DB_HOST,
    DB_NAME: process.env.LOCAL_DB_NAME,
    DB_PASS: process.env.LOCAL_DB_PASS,
    DB_PORT: process.env.LOCAL_DB_PORT || 5432,
  },
};

// Automatically selects correct config
const environment = process.env.NODE_ENV || "development";
console.log(`Using ${environment} environment`);

module.exports = config[environment];
