import "dotenv/config";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(currentDir, "../migrations/001_evidence_v1.sql");
const sql = await readFile(migrationPath, "utf8");
const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  await pool.query(sql);
  process.stdout.write("knowledge_generator migration applied\n");
} finally {
  await pool.end();
}
