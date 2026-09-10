import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config, githubAppReady } from "../config";
import { installUrl, parseInstallState } from "../infra/githubApp";
import {
  getPublicBranchHeadSha,
  getPublicRepository,
  listPublicBranches,
} from "../infra/githubPublic";
import { badRequest } from "../lib/errors";
import { bindRepositoryBody, parseOrThrow, parseRepoRef, projectIdParam } from "../schemas/requests";
import {
  bindRepository,
  deleteBinding,
  listBindings,
  recordInstallation,
} from "../services/repository";
import { clientIp, requireProjectRole } from "./hooks";

const installUrlQuery = z.object({ projectId: z.string().uuid() });
const callbackQuery = z.object({
  installation_id: z.coerce.number().int().positive().optional(),
  state: z.string().optional(),
  setup_action: z.string().optional(),
});
const publicRepoQuery = z.object({ repo: z.string().trim().min(3).max(300) });
const publicBranchQuery = publicRepoQuery.extend({ branch: z.string().trim().min(1).max(200) });
const bindingParam = projectIdParam.extend({ bindingId: z.string().uuid() });

function publicRepoFromQuery(value: string): string {
  const repo = parseRepoRef(value);
  if (!repo) throw badRequest("GitHub 仓库格式必须是 owner/repo 或完整 URL");
  return repo;
}

/** 契约 §4.4 仓库接入 */
export const repositoryRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/github/public/repository", async (req) => {
    const query = parseOrThrow(publicRepoQuery, req.query);
    return getPublicRepository(publicRepoFromQuery(query.repo));
  });

  app.get("/api/github/public/branches", async (req) => {
    const query = parseOrThrow(publicRepoQuery, req.query);
    const repoFullName = publicRepoFromQuery(query.repo);
    return { items: await listPublicBranches(repoFullName) };
  });

  app.get("/api/github/public/head", async (req) => {
    const query = parseOrThrow(publicBranchQuery, req.query);
    const repoFullName = publicRepoFromQuery(query.repo);
    return { commitSha: await getPublicBranchHeadSha(repoFullName, query.branch) };
  });

  app.get("/api/github/app/install-url", async (req) => {
    const { projectId } = parseOrThrow(installUrlQuery, req.query);
    await requireProjectRole(req, projectId, "editor");
    // GitHub App 未配置时返回占位 URL（契约允许 P2 前 mock），前端行为不变
    return { url: installUrl(projectId), ready: githubAppReady() };
  });

  /** GitHub 安装回调（公开路径，靠 state 关联 project） */
  app.get("/api/github/app/callback", async (req, reply) => {
    const q = parseOrThrow(callbackQuery, req.query);
    const state = parseInstallState(q.state);
    if (state && q.installation_id) {
      await recordInstallation(state.projectId, q.installation_id).catch(() => undefined);
    }
    return reply
      .type("text/html; charset=utf-8")
      .send(
        `<!doctype html><meta charset="utf-8"><title>VisionOwl</title>` +
          `<body style="font-family:system-ui;background:#050605;color:#f4f7f3;padding:48px">` +
          `<h2 style="color:#58ff3d">GitHub App 安装完成</h2>` +
          `<p>installation_id: ${q.installation_id ?? "(未提供)"}</p>` +
          `<p>回到 VisionOwl 客户端选择仓库与目标分支即可。</p></body>`,
      );
  });

  const addRepository = async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = parseOrThrow(projectIdParam, req.params);
    const membership = await requireProjectRole(req, id, "editor");
    const body = parseOrThrow(bindRepositoryBody, req.body);
    let verified = body;
    if (!body.installationId) {
      const repository = await getPublicRepository(body.repoFullName);
      await getPublicBranchHeadSha(repository.fullName, body.branch);
      verified = { ...body, repoFullName: repository.fullName, repositoryId: repository.id };
    }
    const binding = await bindRepository(id, membership.userId, verified, clientIp(req));
    return reply.code(201).send(binding);
  };

  app.get("/api/projects/:id/repositories", async (req) => {
    const { id } = parseOrThrow(projectIdParam, req.params);
    await requireProjectRole(req, id, "editor");
    return { items: await listBindings(id) };
  });

  app.post("/api/projects/:id/repositories", addRepository);
  /** 兼容旧客户端。 */
  app.post("/api/projects/:id/repository", addRepository);

  app.delete("/api/projects/:id/repositories/:bindingId", async (req, reply) => {
    const { id, bindingId } = parseOrThrow(bindingParam, req.params);
    const membership = await requireProjectRole(req, id, "editor");
    await deleteBinding(id, bindingId, membership.userId, clientIp(req));
    return reply.code(204).send();
  });

  /** 契约外的运维加法：当前部署是否具备真实 GitHub 能力 */
  app.get("/api/github/app/status", async () => ({
    ready: githubAppReady(),
    appSlug: config.githubAppSlug || null,
    webhookConfigured: Boolean(config.githubWebhookSecret),
  }));
};
