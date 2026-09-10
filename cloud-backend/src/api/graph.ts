import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { decodeCursor, parseLimit } from "../lib/pagination";
import { parseOrThrow, projectIdParam, versionNoParam } from "../schemas/requests";
import {
  getCurrentVersion,
  getVersion,
  listVersions,
  readVersionArtifact,
} from "../services/graph";
import { requireProjectRole } from "./hooks";

const pageQuery = z.object({ limit: z.unknown().optional(), cursor: z.unknown().optional() });

/** 契约 §4.6 图谱（全部只读） */
export const graphRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/projects/:id/graph/current", async (req) => {
    const { id } = parseOrThrow(projectIdParam, req.params);
    await requireProjectRole(req, id, "editor");
    return getCurrentVersion(id);
  });

  app.get("/api/projects/:id/graph/versions", async (req) => {
    const { id } = parseOrThrow(projectIdParam, req.params);
    await requireProjectRole(req, id, "editor");
    const q = parseOrThrow(pageQuery, req.query ?? {});
    return listVersions(id, parseLimit(q.limit), decodeCursor(q.cursor));
  });

  app.get("/api/projects/:id/graph/versions/:no", async (req) => {
    const { id, no } = parseOrThrow(versionNoParam, req.params);
    await requireProjectRole(req, id, "editor");
    return getVersion(id, no);
  });

  /**
   * artifact 直出 graph.json 本体。
   * MVP 读本地 ARTIFACTS_DIR；二期换 OSS 签名 URL 时本端点可 302，客户端无需改动。
   */
  app.get("/api/projects/:id/graph/versions/:no/artifact", async (req, reply) => {
    const { id, no } = parseOrThrow(versionNoParam, req.params);
    await requireProjectRole(req, id, "editor");
    const buf = await readVersionArtifact(id, no);
    return reply
      .header("Content-Type", "application/json; charset=utf-8")
      .header("Cache-Control", "private, max-age=60")
      .send(buf);
  });
};
