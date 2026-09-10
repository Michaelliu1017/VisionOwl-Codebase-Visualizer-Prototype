import type { FastifyPluginAsync } from "fastify";
import { config } from "../config";
import { badRequest } from "../lib/errors";
import {
  integrationArtifactParam,
  integrationFailureBody,
  integrationProgressBody,
  internalRunParam,
  knowledgeCompleteBody,
  skillLabCompleteBody,
  skillLabRepositoryParam,
  skillLabRepositoryQuery,
} from "../schemas/knowledge";
import { parseOrThrow } from "../schemas/requests";
import {
  completeKnowledgeRun,
  failKnowledgeRun,
  getKnowledgeRunCommand,
  readKnowledgeRunGraph,
  updateKnowledgeRunProgress,
  uploadIntegrationArtifact,
} from "../services/knowledge";
import {
  completeSkillLabRun,
  createSkillLabRun,
  failSkillLabRun,
  getSkillLabRunCommand,
  readSkillLabInput,
  readSkillLabRepositoryArchive,
  updateSkillLabRunProgress,
} from "../services/skillLab";

/** Knowledge Generator 与 Skill Lab 的机器接口；由全局钩子校验服务令牌。 */
export const integrationRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: config.integrationArtifactMaxBytes },
    (_req, body, done) => done(null, body),
  );

  app.get("/internal/v1/knowledge-runs/:runId/command", async (req) => {
    const { runId } = parseOrThrow(internalRunParam, req.params);
    return getKnowledgeRunCommand(runId);
  });

  app.get("/internal/v1/skilllab-runs/:runId/command", async (req) => {
    const { runId } = parseOrThrow(internalRunParam, req.params);
    return getSkillLabRunCommand(runId);
  });

  app.get("/internal/v1/knowledge-runs/:runId/input/graph", async (req, reply) => {
    const { runId } = parseOrThrow(internalRunParam, req.params);
    reply.type("application/json; charset=utf-8");
    return reply.send(await readKnowledgeRunGraph(runId));
  });

  app.get("/internal/v1/skilllab-runs/:runId/input/skill", async (req, reply) => {
    const { runId } = parseOrThrow(internalRunParam, req.params);
    reply.type("application/zip");
    return reply.send(await readSkillLabInput(runId, "skill"));
  });

  app.get("/internal/v1/skilllab-runs/:runId/input/baseline", async (req, reply) => {
    const { runId } = parseOrThrow(internalRunParam, req.params);
    reply.type("application/zip");
    return reply.send(await readSkillLabInput(runId, "baseline"));
  });

  app.get(
    "/internal/v1/skilllab-runs/:runId/input/repositories/:bindingId/archive",
    async (req, reply) => {
      const { runId, bindingId } = parseOrThrow(skillLabRepositoryParam, req.params);
      const { sha } = parseOrThrow(skillLabRepositoryQuery, req.query);
      reply.type("application/zip");
      return reply.send(await readSkillLabRepositoryArchive(runId, bindingId, sha));
    },
  );

  app.put("/internal/v1/integration-runs/:runId/artifacts/:fileName", async (req, reply) => {
    const { runId, fileName } = parseOrThrow(integrationArtifactParam, req.params);
    if (!Buffer.isBuffer(req.body)) {
      throw badRequest("产物上传必须使用 application/octet-stream");
    }
    const checksum = req.headers["x-content-sha256"];
    if (checksum !== undefined && (typeof checksum !== "string" || !/^[a-f0-9]{64}$/i.test(checksum))) {
      throw badRequest("X-Content-SHA256 格式非法");
    }
    return reply.code(201).send(
      await uploadIntegrationArtifact(runId, fileName, req.body, checksum),
    );
  });

  app.post("/internal/v1/knowledge-runs/:runId/progress", async (req) => {
    const { runId } = parseOrThrow(internalRunParam, req.params);
    const body = parseOrThrow(integrationProgressBody, req.body);
    if (body.status !== "running" && body.status !== "publishing") {
      throw badRequest("Knowledge Generator 状态只能是 running 或 publishing");
    }
    return updateKnowledgeRunProgress(runId, { ...body, status: body.status });
  });

  app.post("/internal/v1/knowledge-runs/:runId/complete", async (req) => {
    const { runId } = parseOrThrow(internalRunParam, req.params);
    const body = parseOrThrow(knowledgeCompleteBody, req.body);
    const result = await completeKnowledgeRun(runId, body.artifacts);
    // C 模块未部署时，Wiki/Skill 生成仍正常完成；只有显式启用后才自动优化。
    const settled = config.skillLabAutoOptimize
      ? await Promise.allSettled(
          result.candidateSkillVersionIds.map((versionId) =>
            createSkillLabRun(result.run.projectId, versionId)),
        )
      : [];
    const skillLabRuns = settled.flatMap((item) =>
      item.status === "fulfilled" ? [item.value] : [],
    );
    return { run: result.run, skillLabRuns };
  });

  app.post("/internal/v1/knowledge-runs/:runId/fail", async (req) => {
    const { runId } = parseOrThrow(internalRunParam, req.params);
    const body = parseOrThrow(integrationFailureBody, req.body);
    return failKnowledgeRun(runId, body.error);
  });

  app.post("/internal/v1/skilllab-runs/:runId/progress", async (req) => {
    const { runId } = parseOrThrow(internalRunParam, req.params);
    const body = parseOrThrow(integrationProgressBody, req.body);
    if (!["evaluating", "optimizing", "validating"].includes(body.status)) {
      throw badRequest("Skill Lab 状态非法");
    }
    return updateSkillLabRunProgress(runId, {
      ...body,
      status: body.status as "evaluating" | "optimizing" | "validating",
    });
  });

  app.post("/internal/v1/skilllab-runs/:runId/complete", async (req) => {
    const { runId } = parseOrThrow(internalRunParam, req.params);
    const body = parseOrThrow(skillLabCompleteBody, req.body);
    return completeSkillLabRun({ runId, ...body });
  });

  app.post("/internal/v1/skilllab-runs/:runId/fail", async (req) => {
    const { runId } = parseOrThrow(internalRunParam, req.params);
    const body = parseOrThrow(integrationFailureBody, req.body);
    return failSkillLabRun(runId, body.error);
  });
};
