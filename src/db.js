const { Pool } = require("pg");

module.exports = new Pool({
  connectionString: process.env.DB_URL,
  ssl: process.env.DB_SSL === "false" ? false : { rejectUnauthorized: false },
});
