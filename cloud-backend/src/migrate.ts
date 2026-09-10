/**
 * 迁移执行器：按文件名顺序执行 migrations/*.sql，已执行的跳过。
 *   npm run migrate            (开发，tsx)
 *   node dist/migrate.js       (生产)
 */
import fs from "node:fs";
import path from "node:path";
import { closeDb, getPool, query } from "./infra/pg";

function migrationsDir(): string {
  const candidates = [
    path.join(__dirname, "..", "migrations"),
    path.join(process.cwd(), "migrations"),
  ];
  for (const dir of candidates) if (fs.existsSync(dir)) return dir;
  throw new Error("找不到 migrations 目录");
}

async function main(): Promise<void> {
  const dir = migrationsDir();
  await query(`CREATE TABLE IF NOT EXISTS _migrations (
                 name text PRIMARY KEY,
                 applied_at timestamptz NOT NULL DEFAULT now()
               )`);

  const applied = new Set(
    (await query<{ name: string }>(`SELECT name FROM _migrations`)).map((r) => r.name),
  );

  const files = fs
    .readdirSync(dir)
    // 只执行受版本号管理的迁移，避免 macOS 上传产生的 ._*.sql 元数据被误执行。
    .filter((f) => /^\d+_[A-Za-z0-9_-]+\.sql$/.test(f))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`[migrate] 跳过 ${file}（已执行）`);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(`INSERT INTO _migrations (name) VALUES ($1)`, [file]);
      await client.query("COMMIT");
      console.log(`[migrate] 已执行 ${file}`);
      count += 1;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error(`执行 ${file} 失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      client.release();
    }
  }
  console.log(`[migrate] 完成，本次新增 ${count} 个迁移，共 ${files.length} 个`);
}

void main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[migrate] 失败：", err instanceof Error ? err.message : err);
    await closeDb();
    process.exit(1);
  });
