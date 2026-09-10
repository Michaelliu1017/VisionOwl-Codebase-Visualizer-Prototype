/**
 * Seed（契约 §8 Canonical Demo 数据）—— **可重复执行、幂等**
 *
 *   npm run migrate && npm run seed
 *
 * 产出与桌面端 mock 完全一致的演示数据：两个账号、EventHub 项目、
 * 仓库绑定、图谱 v1（17 节点/31 边）、2 篇文档、1 条批注。
 */
import { closeDb, query, queryOne } from "../infra/pg";
import { closeRedis } from "../infra/redis";
import { ensureArtifactsDir } from "../infra/artifacts";
import { hashPassword } from "../lib/password";
import { saveVersion } from "../services/graph";
import { loadDemoGraph } from "./demoGraph";

const OWNER = { email: "owner@demo.dev", name: "Owner Demo", password: "demo1234" };
const EDITOR = { email: "editor@demo.dev", name: "Editor Demo", password: "demo1234" };
const PROJECT_NAME = "EventHub";
const REPO = "team-046/eventhub-fixture";
const BRANCH = "main";
const COMMIT = "171b8f0";

async function upsertUser(u: typeof OWNER): Promise<string> {
  const existing = await queryOne<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [u.email]);
  if (existing) return existing.id;
  const rows = await query<{ id: string }>(
    `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id`,
    [u.email, u.name, await hashPassword(u.password)],
  );
  return rows[0]!.id;
}

async function upsertProject(ownerId: string): Promise<string> {
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM projects WHERE name = $1 AND owner_id = $2`,
    [PROJECT_NAME, ownerId],
  );
  if (existing) return existing.id;
  const rows = await query<{ id: string }>(
    `INSERT INTO projects (name, owner_id) VALUES ($1, $2) RETURNING id`,
    [PROJECT_NAME, ownerId],
  );
  return rows[0]!.id;
}

async function ensureMember(projectId: string, userId: string, role: string): Promise<void> {
  await query(
    `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [projectId, userId, role],
  );
}

async function ensureBinding(projectId: string): Promise<void> {
  await query(
    `INSERT INTO repository_bindings (project_id, repo_full_name, branch, current_commit_sha, installation_id)
     VALUES ($1, $2, $3, $4, NULL)
     ON CONFLICT (project_id) DO UPDATE
       SET repo_full_name = EXCLUDED.repo_full_name,
           branch = EXCLUDED.branch,
           current_commit_sha = EXCLUDED.current_commit_sha,
           updated_at = now()`,
    [projectId, REPO, BRANCH, COMMIT],
  );
}

async function ensureDocument(
  projectId: string,
  userId: string,
  doc: { scope: string; nodeId: string | null; title: string; url: string; docType: string; status: string },
): Promise<void> {
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM document_links WHERE project_id = $1 AND title = $2`,
    [projectId, doc.title],
  );
  if (existing) {
    await query(
      `UPDATE document_links SET scope = $2, node_id = $3, url = $4, doc_type = $5, status = $6,
              updated_by = $7, updated_at = now()
        WHERE id = $1`,
      [existing.id, doc.scope, doc.nodeId, doc.url, doc.docType, doc.status, userId],
    );
    return;
  }
  await query(
    `INSERT INTO document_links (project_id, scope, node_id, title, url, doc_type, status, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [projectId, doc.scope, doc.nodeId, doc.title, doc.url, doc.docType, doc.status, userId],
  );
}

async function ensureAnnotation(
  projectId: string,
  userId: string,
  targetId: string,
  body: string,
): Promise<void> {
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM annotations WHERE project_id = $1 AND target_id = $2 AND body = $3`,
    [projectId, targetId, body],
  );
  if (existing) return;
  await query(
    `INSERT INTO annotations (project_id, target_kind, target_id, body, author_id)
     VALUES ($1, 'node', $2, $3, $4)`,
    [projectId, targetId, body, userId],
  );
}

async function main(): Promise<void> {
  await ensureArtifactsDir();

  const ownerId = await upsertUser(OWNER);
  const editorId = await upsertUser(EDITOR);
  console.log(`[seed] 账号就绪：${OWNER.email} / ${EDITOR.email}（口令 demo1234）`);

  const projectId = await upsertProject(ownerId);
  await ensureMember(projectId, ownerId, "owner");
  await ensureMember(projectId, editorId, "editor");
  await ensureBinding(projectId);
  console.log(`[seed] 项目 ${PROJECT_NAME} = ${projectId}，绑定 ${REPO}@${BRANCH}#${COMMIT}`);

  const graph = loadDemoGraph();
  const version = await saveVersion({
    projectId,
    commitSha: COMMIT,
    jobId: null,
    graph,
  });
  console.log(
    `[seed] 图谱 v${version.versionNo}：${version.stats.nodeCount} 节点 / ${version.stats.edgeCount} 边 / ${version.stats.inferredCount} 推断`,
  );

  await ensureDocument(projectId, ownerId, {
    scope: "global",
    nodeId: null,
    title: "EventHub 架构总览",
    url: "https://alidocs.dingtalk.com/i/nodes/eventhub-architecture-overview",
    docType: "dingtalk",
    status: "ok",
  });
  await ensureDocument(projectId, ownerId, {
    scope: "module",
    nodeId: "module:modules/booking",
    title: "订单模块说明",
    url: "https://alidocs.dingtalk.com/i/nodes/eventhub-booking-module",
    docType: "dingtalk",
    status: "maybe_stale",
  });
  await ensureAnnotation(
    projectId,
    ownerId,
    "module:modules/booking",
    "幂等键在 v2 迁移后改为 orderId+ts",
  );
  console.log("[seed] 文档 2 篇、批注 1 条就绪");

  console.log("\n[seed] 完成。联调用：");
  console.log(`  PID=${projectId}`);
  console.log(`  curl -s $BASE/api/auth/login -H 'Content-Type: application/json' \\`);
  console.log(`    -d '{"email":"${OWNER.email}","password":"demo1234"}'`);
}

void main()
  .then(async () => {
    await Promise.allSettled([closeDb(), closeRedis()]);
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[seed] 失败：", err);
    await Promise.allSettled([closeDb(), closeRedis()]);
    process.exit(1);
  });
