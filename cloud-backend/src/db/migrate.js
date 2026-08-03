"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const { postgresPoolOptions } = require("./pool-options");

async function migrate(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const pool = new Pool({
    ...postgresPoolOptions(databaseUrl),
    max: 1,
    connectionTimeoutMillis: 8_000,
  });
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('visionowl_schema_migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const directory = path.resolve(__dirname, "../../migrations");
    const files = fs.readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      const applied = await client.query(
        "SELECT 1 FROM schema_migrations WHERE version = $1",
        [version],
      );
      if (applied.rowCount > 0) {
        process.stdout.write(`Skipped ${file}\n`);
        continue;
      }
      const sql = fs.readFileSync(path.join(directory, file), "utf8");
      await client.query(sql);
      process.stdout.write(`Applied ${file}\n`);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('visionowl_schema_migrations'))").catch(() => {});
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  migrate().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { migrate };
