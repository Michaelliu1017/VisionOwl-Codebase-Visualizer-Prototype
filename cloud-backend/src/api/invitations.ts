import type { FastifyPluginAsync } from "fastify";
import {
  createInvitationBody,
  invIdParam,
  parseOrThrow,
  projectIdParam,
  redeemBody,
} from "../schemas/requests";
import {
  createInvitation,
  listInvitations,
  redeemInvitation,
  revokeInvitation,
} from "../services/invitations";
import { getMember } from "../services/members";
import { sseHub } from "../realtime/sseHub";
import { clientIp, currentUserId, requireProjectRole } from "./hooks";

/** 契约 §4.3 邀请 */
export const invitationRoutes: FastifyPluginAsync = async (app) => {
  app.post("/api/projects/:id/invitations", async (req, reply) => {
    const { id } = parseOrThrow(projectIdParam, req.params);
    const membership = await requireProjectRole(req, id, "owner");
    parseOrThrow(createInvitationBody, req.body ?? {});
    const created = await createInvitation(id, membership.userId, clientIp(req));
    return reply.code(201).send(created);
  });

  app.get("/api/projects/:id/invitations", async (req) => {
    const { id } = parseOrThrow(projectIdParam, req.params);
    await requireProjectRole(req, id, "editor");
    return { items: await listInvitations(id) };
  });

  app.delete("/api/projects/:id/invitations/:invId", async (req, reply) => {
    const { id, invId } = parseOrThrow(invIdParam, req.params);
    const membership = await requireProjectRole(req, id, "editor");
    await revokeInvitation(id, invId, membership.userId, clientIp(req));
    return reply.code(204).send();
  });

  /** 登录即可兑换；失败统一 410 INVITATION_INVALID */
  app.post("/api/invitations/redeem", async (req) => {
    const body = parseOrThrow(redeemBody, req.body);
    const userId = currentUserId(req);
    const result = await redeemInvitation(body.key, userId, clientIp(req));
    if (result.joined) {
      const member = await getMember(result.projectId, userId);
      if (member) {
        sseHub.emitAsync(result.projectId, "member.joined", {
          user: { id: member.user.id, name: member.user.name },
          role: member.role,
        });
      }
    }
    return { projectId: result.projectId, role: result.role };
  });
};
