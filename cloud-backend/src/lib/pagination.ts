/**
 * 分页游标（契约 §3）：请求 ?limit=20&cursor=<opaque>，响应 { items, nextCursor }
 * cursor 对客户端不透明：base64url("<ISO createdAt>|<uuid id>")，按 (created_at DESC, id DESC) 排序
 */
import { badRequest } from "./errors";

export interface Cursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.createdAt}|${c.id}`, "utf8").toString("base64url");
}

export function decodeCursor(raw: unknown): Cursor | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw badRequest("cursor 必须是字符串", { field: "cursor" });
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const sep = decoded.indexOf("|");
  if (sep <= 0) throw badRequest("cursor 格式非法", { field: "cursor" });
  const createdAt = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (!createdAt || !id || Number.isNaN(Date.parse(createdAt))) {
    throw badRequest("cursor 格式非法", { field: "cursor" });
  }
  return { createdAt, id };
}

export function parseLimit(raw: unknown, fallback = 20, max = 100): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw badRequest(`limit 必须是 1..${max} 的整数`, { field: "limit" });
  }
  return n;
}

/** 统一构造分页响应：多查一条判断是否还有下一页 */
export function buildPage<T extends { createdAt: string; id: string }>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1]!;
  return { items, nextCursor: encodeCursor({ createdAt: last.createdAt, id: last.id }) };
}
