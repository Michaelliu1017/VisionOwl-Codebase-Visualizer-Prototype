import type { FastifyPluginAsync } from "fastify";
import { config } from "../config";
import { loginBody, parseOrThrow, registerBody } from "../schemas/requests";
import { getUserById, login, register } from "../services/auth";
import { audit } from "../services/audit";
import { clientIp, currentUserId } from "./hooks";

/** 契约 §4.1 Auth */
export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post("/api/auth/register", async (req, reply) => {
    const body = parseOrThrow(registerBody, req.body);
    const out = await register(body);
    await audit({
      projectId: null,
      actorId: out.user.id,
      action: "user.registered",
      targetType: "user",
      targetId: out.user.id,
      ip: clientIp(req),
    });
    return reply.code(201).send(out);
  });

  app.post(
    "/api/auth/login",
    {
      config: {
        rateLimit: { max: config.loginRateMax, timeWindow: config.loginRateWindow },
      },
    },
    async (req) => {
      const body = parseOrThrow(loginBody, req.body);
      return login(body);
    },
  );

  app.get("/api/auth/me", async (req) => ({ user: await getUserById(currentUserId(req)) }));

  /** 无状态 JWT，登出由客户端丢弃 token 完成（spec §9 列出该端点） */
  app.post("/api/auth/logout", async (_req, reply) => reply.code(204).send());
};
