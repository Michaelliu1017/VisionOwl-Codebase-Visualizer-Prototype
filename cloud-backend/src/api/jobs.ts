import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { decodeCursor, parseLimit } from "../lib/pagination";
import { createJobBody, jobIdParam, parseOrThrow, projectIdParam } from "../schemas/requests";
import { createJob, getJob, getJobProjectId, listJobs } from "../services/jobs";
import { resolveProjectRepositorySnapshot } from "../services/repositorySnapshot";
import { assertJobVisible, clientIp, requireProjectRole } from "./hooks";

const pageQuery = z.object({ limit: z.unknown().optional(), cursor: z.unknown().optional() });

/** 契约 §4.5 分析任务 */
export const jobRoutes: FastifyPluginAsync = async (app) => {
  app.post("/api/projects/:id/jobs", async (req, reply) => {
    const { id } = parseOrThrow(projectIdParam, req.params);
    const membership = await requireProjectRole(req, id, "editor");
    const body = parseOrThrow(createJobBody, req.body ?? {});

    const snapshot = await resolveProjectRepositorySnapshot(id);
    if (body.targetCommitSha && snapshot.bindings.length === 1) {
      const key = Object.keys(snapshot.repositoryCommits)[0]!;
      snapshot.repositoryCommits[key] = body.targetCommitSha;
      snapshot.targetCommitSha = body.targetCommitSha;
    }

    const { job } = await createJob({
      projectId: id,
      type: "full",
      actorId: membership.userId,
      targetCommitSha: snapshot.targetCommitSha,
      repositoryCommits: snapshot.repositoryCommits,
      forceReanalysis: body.force,
      ip: clientIp(req),
    });
    return reply.code(202).send(job);
  });

  app.get("/api/projects/:id/jobs", async (req) => {
    const { id } = parseOrThrow(projectIdParam, req.params);
    await requireProjectRole(req, id, "editor");
    const q = parseOrThrow(pageQuery, req.query ?? {});
    return listJobs(id, parseLimit(q.limit), decodeCursor(q.cursor));
  });

  app.get("/api/jobs/:jobId", async (req) => {
    const { jobId } = parseOrThrow(jobIdParam, req.params);
    await assertJobVisible(req, await getJobProjectId(jobId));
    return getJob(jobId);
  });
};
