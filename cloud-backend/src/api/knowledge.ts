import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  assetContentQuery,
  createKnowledgeRunBody,
  knowledgeAssetParam,
  knowledgeRunParam,
} from "../schemas/knowledge";
import { parseOrThrow, projectIdParam } from "../schemas/requests";
import {
  createKnowledgeRun,
  getKnowledgeAssetManifest,
  getKnowledgeRun,
  listKnowledgeAssets,
  listKnowledgeAssetVersions,
  readKnowledgeAssetBundle,
  readKnowledgeAssetContent,
} from "../services/knowledge";
import { getSkillLabRun, readSkillLabArtifact } from "../services/skillLab";
import { clientIp, requireProjectRole } from "./hooks";
import { audit } from "../services/audit";

const skillLabRunParam = z.object({ id: z.string().uuid(), runId: z.string().uuid() });

function attachment(name: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Core 对桌面端暴露的工程知识资产 API。 */
export const knowledgeRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/projects/:id/knowledge-assets", async (req) => {
    const { id } = parseOrThrow(projectIdParam, req.params);
    await requireProjectRole(req, id, "editor");
    return { items: await listKnowledgeAssets(id) };
  });

  app.get("/api/projects/:id/knowledge-assets/:assetId/versions", async (req) => {
    const { id, assetId } = parseOrThrow(knowledgeAssetParam, req.params);
    await requireProjectRole(req, id, "editor");
    return { items: await listKnowledgeAssetVersions(id, assetId) };
  });

  app.get("/api/projects/:id/knowledge-assets/:assetId/manifest", async (req) => {
    const { id, assetId } = parseOrThrow(knowledgeAssetParam, req.params);
    await requireProjectRole(req, id, "editor");
    return getKnowledgeAssetManifest(id, assetId);
  });

  app.get("/api/projects/:id/knowledge-assets/:assetId/tree", async (req) => {
    const { id, assetId } = parseOrThrow(knowledgeAssetParam, req.params);
    await requireProjectRole(req, id, "editor");
    return getKnowledgeAssetManifest(id, assetId);
  });

  app.get("/api/projects/:id/knowledge-assets/:assetId/content", async (req, reply) => {
    const { id, assetId } = parseOrThrow(knowledgeAssetParam, req.params);
    const { path } = parseOrThrow(assetContentQuery, req.query);
    await requireProjectRole(req, id, "editor");
    const file = await readKnowledgeAssetContent(id, assetId, path);
    reply.type(file.mediaType);
    return reply.send(file.content);
  });

  app.get("/api/projects/:id/knowledge-assets/:assetId/download", async (req, reply) => {
    const { id, assetId } = parseOrThrow(knowledgeAssetParam, req.params);
    await requireProjectRole(req, id, "editor");
    const bundle = await readKnowledgeAssetBundle(id, assetId);
    reply.type("application/zip");
    reply.header("Content-Disposition", attachment(bundle.fileName));
    return reply.send(bundle.content);
  });

  app.post("/api/projects/:id/knowledge-runs", async (req, reply) => {
    const { id } = parseOrThrow(projectIdParam, req.params);
    const membership = await requireProjectRole(req, id, "editor");
    const body = parseOrThrow(createKnowledgeRunBody, req.body ?? {});
    const run = await createKnowledgeRun({
      projectId: id,
      actorId: membership.userId,
      requestedAssets: body.requestedAssets,
      force: body.force,
    });
    await audit({
      projectId: id,
      actorId: membership.userId,
      action: "knowledge.run.created",
      targetType: "knowledge_run",
      targetId: run.id,
      detail: { requestedAssets: body.requestedAssets, graphVersionNo: run.graphVersionNo },
      ip: clientIp(req),
    });
    return reply.code(202).send(run);
  });

  app.get("/api/projects/:id/knowledge-runs/:runId", async (req) => {
    const { id, runId } = parseOrThrow(knowledgeRunParam, req.params);
    await requireProjectRole(req, id, "editor");
    return getKnowledgeRun(id, runId);
  });

  app.get("/api/projects/:id/skilllab-runs/:runId", async (req) => {
    const { id, runId } = parseOrThrow(skillLabRunParam, req.params);
    await requireProjectRole(req, id, "editor");
    return getSkillLabRun(id, runId);
  });

  app.get("/api/projects/:id/skilllab-runs/:runId/report", async (req, reply) => {
    const { id, runId } = parseOrThrow(skillLabRunParam, req.params);
    await requireProjectRole(req, id, "editor");
    reply.type("application/json; charset=utf-8");
    return reply.send(await readSkillLabArtifact(id, runId, "report"));
  });

  app.get("/api/projects/:id/skilllab-runs/:runId/diff", async (req, reply) => {
    const { id, runId } = parseOrThrow(skillLabRunParam, req.params);
    await requireProjectRole(req, id, "editor");
    reply.type("text/plain; charset=utf-8");
    return reply.send(await readSkillLabArtifact(id, runId, "diff"));
  });
};
