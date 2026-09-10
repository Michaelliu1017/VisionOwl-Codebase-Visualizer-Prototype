import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { parseOrThrow } from "../schemas/requests";
import {
  disconnectConnection,
  getDingtalkAuthTask,
  listConnections,
  selectConnection,
  startDingtalkAuth,
  updateConnection,
} from "../services/dingtalk";
import { currentUserId } from "./hooks";

const connectionParam = z.object({ connectionId: z.string().uuid() });
const authTaskParam = z.object({ taskId: z.string().uuid() });
const destinationBody = z.object({
  workspaceId: z.string().trim().max(300).nullable().optional(),
  folderId: z.string().trim().max(1000).nullable().optional(),
});

export const dingtalkRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/integrations/dingtalk", async (req) => {
    const connections = await listConnections(currentUserId(req));
    return { configured: connections.some((connection) => connection.status === "active"), connections };
  });

  app.post(
    "/api/integrations/dingtalk/connect",
    { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      const task = await startDingtalkAuth(currentUserId(req));
      return reply.code(202).send(task);
    },
  );

  app.get("/api/integrations/dingtalk/connect/:taskId", async (req) => {
    const { taskId } = parseOrThrow(authTaskParam, req.params);
    return getDingtalkAuthTask(currentUserId(req), taskId);
  });

  app.post("/api/integrations/dingtalk/:connectionId/select", async (req) => {
    const { connectionId } = parseOrThrow(connectionParam, req.params);
    return selectConnection(currentUserId(req), connectionId);
  });

  app.patch("/api/integrations/dingtalk/:connectionId", async (req) => {
    const { connectionId } = parseOrThrow(connectionParam, req.params);
    const body = parseOrThrow(destinationBody, req.body ?? {});
    return updateConnection(currentUserId(req), connectionId, body);
  });

  app.delete("/api/integrations/dingtalk/:connectionId", async (req, reply) => {
    const { connectionId } = parseOrThrow(connectionParam, req.params);
    await disconnectConnection(currentUserId(req), connectionId);
    return reply.code(204).send();
  });
};
