/**
 * 会话 token：JWT HS256，载荷 { sub: userId, exp }，有效期 JWT_TTL_DAYS（契约 §3）
 */
import jwt from "jsonwebtoken";
import { config } from "../config";

export interface TokenPayload {
  sub: string;
  exp: number;
  iat: number;
}

export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, config.jwtSecret, {
    algorithm: "HS256",
    expiresIn: `${config.jwtTtlDays}d`,
  });
}

/** 校验失败返回 null（由调用方转成 401 AUTH_REQUIRED），绝不抛裸异常到路由层 */
export function verifyToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] });
    if (typeof decoded === "string" || !decoded.sub) return null;
    return decoded as unknown as TokenPayload;
  } catch {
    return null;
  }
}

/**
 * 从请求中取 token：优先 Authorization: Bearer，其次 ?token=
 * （EventSource 不支持自定义头，契约 §5 要求两种都收）
 */
export function extractToken(headerValue: string | undefined, queryToken: unknown): string | null {
  if (headerValue && headerValue.startsWith("Bearer ")) {
    const t = headerValue.slice("Bearer ".length).trim();
    if (t) return t;
  }
  if (typeof queryToken === "string" && queryToken.trim()) return queryToken.trim();
  return null;
}
