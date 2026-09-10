/**
 * 鉴权钩子（默认拒绝）
 * 只有白名单路径可匿名访问：health / register / login / webhook / GitHub 安装回调。
 * 其余一律要求 Bearer（或 ?token=，供 EventSource 使用）。
 */
import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config";
import { authRequired, notFound } from "../lib/errors";
import { extractToken, verifyToken } from "../lib/jwt";
import { requireMembership, type Membership } from "../services/projects";
import type { Role } from "../types";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

const PUBLIC_PATHS = new Set([
  "/api/health",
  "/api/auth/register",
  "/api/auth/login",
  "/webhook/github",
  "/api/github/app/callback",
]);

export function isPublicPath(url: string): boolean {
  const path = url.split("?")[0] ?? url;
  return PUBLIC_PATHS.has(path);
}

function hasValidIntegrationToken(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const supplied = Buffer.from(value);
  const expected = Buffer.from(config.integrationServiceToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** 全局 onRequest 钩子 */
export async function authenticateHook(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const path = req.url.split("?")[0] ?? req.url;
  if (path.startsWith("/internal/v1/")) {
    if (!config.knowledgeIntegrationEnabled) {
      throw notFound("知识资产扩展未启用");
    }
    if (!hasValidIntegrationToken(req.headers["x-visionowl-service-token"])) {
      throw authRequired("集成服务凭证无效");
    }
    return;
  }
  if (isPublicPath(req.url)) return;

  const query = req.query as { token?: unknown } | undefined;
  const token = extractToken(req.headers.authorization, query?.token);
  if (!token) throw authRequired();

  const payload = verifyToken(token);
  if (!payload) throw authRequired();

  req.userId = payload.sub;
}

export function currentUserId(req: FastifyRequest): string {
  if (!req.userId) throw authRequired();
  return req.userId;
}

export function clientIp(req: FastifyRequest): string | null {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip || null;
}

/** Project 级鉴权：非成员 404、角色不足 403 */
export async function requireProjectRole(
  req: FastifyRequest,
  projectId: string,
  minRole: Role = "editor",
): Promise<Membership> {
  return requireMembership(projectId, currentUserId(req), minRole);
}

/** 任务归属校验：任务不属于任何可见 Project 时 404 */
export async function assertJobVisible(req: FastifyRequest, projectId: string | null): Promise<Membership> {
  if (!projectId) throw notFound("任务不存在");
  return requireProjectRole(req, projectId, "editor");
}
