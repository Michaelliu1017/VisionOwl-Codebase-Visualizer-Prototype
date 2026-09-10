import type { FastifyPluginAsync } from "fastify";
import { streamingCorsHeaders } from "../lib/cors";
import { parseOrThrow, projectIdParam } from "../schemas/requests";
import { parseLastEventId, sseHub } from "../realtime/sseHub";
import { requireProjectRole } from "./hooks";

/**
 * 契约 §5 实时事件
 * GET /api/projects/:id/events  (Bearer 或 ?token=)
 * 心跳 25s、事件自增 id、Last-Event-ID 尽力续传
 */
export const eventRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/projects/:id/events", async (req, reply) => {
    const { id } = parseOrThrow(projectIdParam, req.params);
    await requireProjectRole(req, id, "editor");

    const lastEventId = parseLastEventId(req.headers["last-event-id"]);
    reply.hijack();
    sseHub.attach(id, reply.raw, lastEventId, streamingCorsHeaders(req.headers.origin));
  });
};
