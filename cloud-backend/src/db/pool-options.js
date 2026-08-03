"use strict";

const fs = require("node:fs");

function postgresPoolOptions(databaseUrl, overrides = {}) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");

  const sslEnabled = overrides.sslEnabled ?? process.env.PGSSL === "true";
  const caFile = overrides.caFile || process.env.PGSSL_CA_FILE;
  const ssl = sslEnabled
    ? {
        rejectUnauthorized: true,
        ...(caFile ? { ca: fs.readFileSync(caFile, "utf8") } : {}),
      }
    : undefined;

  return {
    connectionString: databaseUrl,
    ...(ssl ? { ssl } : {}),
  };
}

module.exports = { postgresPoolOptions };
