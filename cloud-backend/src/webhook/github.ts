/**
 * Webhook Receiver（spec §11.2 / §12-5）
 * 职责边界：验签 → 过滤 → 幂等 → 入队，**仅此而已**，立即 202。
 * 任何耗时工作都交给 Job Service / Worker。
 */
import type { FastifyPluginAsync } from "fastify";
import { config } from "../config";
import { query } from "../infra/pg";
import { parsePushEvent, verifyWebhookSignature } from "../infra/githubApp";
import { AppError } from "../lib/errors";
import { createJob } from "../services/jobs";
import { findProjectsByRepoBranch } from "../services/repository";
import { resolveProjectRepositorySnapshot } from "../services/repositorySnapshot";
import { findVersionByCommit } from "../services/graph";
import { sseHub } from "../realtime/sseHub";

/** delivery_id 幂等：首次插入返回 true，重放返回 false */
async function claimDelivery(deliveryId: string, event: string): Promise<boolean> {
  const rows = await query<{ delivery_id: string }>(
    `INSERT INTO webhook_deliveries (delivery_id, event) VALUES ($1, $2)
     ON CONFLICT (delivery_id) DO NOTHING
     RETURNING delivery_id`,
    [deliveryId, event],
  );
  return rows.length > 0;
}

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  // 该插件作用域内以 Buffer 接收正文——HMAC 必须对原始字节计算
  app.addContentTypeParser(
    ["application/json", "application/x-www-form-urlencoded"],
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  app.post("/webhook/github", async (req, reply) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    const event = String(req.headers["x-github-event"] ?? "");
    const deliveryId = String(req.headers["x-github-delivery"] ?? "");

    if (!config.githubWebhookSecret) {
      req.log.error("收到 webhook 但 GITHUB_WEBHOOK_SECRET 未配置，拒绝处理");
      throw new AppError("FORBIDDEN", "webhook 未配置密钥");
    }
    if (!verifyWebhookSignature(raw, req.headers["x-hub-signature-256"])) {
      req.log.warn({ deliveryId, event }, "webhook 验签失败");
      throw new AppError("FORBIDDEN", "签名校验失败");
    }

    // ping 事件直接确认，便于 GitHub 侧配置自检
    if (event === "ping") return reply.code(202).send({ accepted: true, event });
    if (event !== "push") return reply.code(202).send({ accepted: true, ignored: event });

    if (deliveryId && !(await claimDelivery(deliveryId, event))) {
      return reply.code(202).send({ accepted: true, duplicate: true });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new AppError("VALIDATION_FAILED", "webhook 正文不是合法 JSON");
    }

    const push = parsePushEvent(payload);
    if (!push || push.deleted) {
      return reply.code(202).send({ accepted: true, ignored: "非分支推送或分支删除" });
    }

    const bindings = await findProjectsByRepoBranch(push.repoFullName, push.branch);
    if (bindings.length === 0) {
      return reply.code(202).send({ accepted: true, ignored: "无项目绑定该 repo@branch" });
    }

    // 先响应 202 的语义：这里的处理都很轻（仅入队），同步完成即可
    const created: Array<{ projectId: string; jobId: string | null; note?: string }> = [];
    for (const b of bindings) {
      sseHub.emitAsync(b.projectId, "repository.push.received", {
        repoFullName: push.repoFullName,
        branch: push.branch,
        beforeSha: push.beforeSha,
        headSha: push.headSha,
      });
      const snapshot = await resolveProjectRepositorySnapshot(b.projectId, {
        [b.repositoryKey]: push.headSha,
      });
      const base = b.currentCommitSha ?? push.beforeSha;
      // 已分析过该 SHA → 直接跳过（成本铁律：SHA 缓存复用）
      const cached = await findVersionByCommit(b.projectId, snapshot.targetCommitSha);
      if (cached) {
        created.push({ projectId: b.projectId, jobId: null, note: "该 commit 已有图谱版本，跳过" });
        continue;
      }
      try {
        const { job, debounced } = await createJob({
          projectId: b.projectId,
          type: base ? "incremental" : "full",
          actorId: null,
          targetCommitSha: snapshot.targetCommitSha,
          baseCommitSha: base,
          repositoryCommits: snapshot.repositoryCommits,
          debounce: true,
        });
        created.push({
          projectId: b.projectId,
          jobId: job.id,
          ...(debounced ? { note: "去抖窗口内合并" } : {}),
        });
      } catch (err) {
        if (err instanceof AppError && err.code === "DUPLICATE") {
          created.push({
            projectId: b.projectId,
            jobId: (err.details.jobId as string) ?? null,
            note: "去重命中",
          });
          continue;
        }
        req.log.error({ err, projectId: b.projectId }, "webhook 建任务失败");
        created.push({ projectId: b.projectId, jobId: null, note: "建任务失败" });
      }
    }

    return reply.code(202).send({ accepted: true, jobs: created });
  });
};
