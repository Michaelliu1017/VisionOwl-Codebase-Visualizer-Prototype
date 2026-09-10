import type { FastifyPluginAsync } from "fastify";
import { memberParam, parseOrThrow, patchMemberBody, projectIdParam } from "../schemas/requests";
import { listMembers, removeMember, updateMemberRole } from "../services/members";
import { clientIp, requireProjectRole } from "./hooks";

/** 契约 §4.3 成员 */
export const memberRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/projects/:id/members", async (req) => {
    const { id } = parseOrThrow(projectIdParam, req.params);
    await requireProjectRole(req, id, "editor");
    return { items: await listMembers(id) };
  });

  app.patch("/api/projects/:id/members/:userId", async (req) => {
    const { id, userId } = parseOrThrow(memberParam, req.params);
    const membership = await requireProjectRole(req, id, "editor");
    const body = parseOrThrow(patchMemberBody, req.body);
    return updateMemberRole(id, userId, body.role, membership.userId, clientIp(req));
  });

  app.delete("/api/projects/:id/members/:userId", async (req, reply) => {
    const { id, userId } = parseOrThrow(memberParam, req.params);
    const membership = await requireProjectRole(req, id, "editor");
    await removeMember(id, userId, membership.userId, clientIp(req));
    return reply.code(204).send();
  });
};
