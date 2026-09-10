/** 认证：注册 / 登录 / 当前用户（契约 §4.1）。services 层不感知 HTTP。 */
import { isUniqueViolation, query, queryOne } from "../infra/pg";
import { duplicate, notFound, badRequest } from "../lib/errors";
import { signToken } from "../lib/jwt";
import { hashPassword, verifyPassword } from "../lib/password";
import { isoReq } from "../lib/time";
import type { UserDto } from "../types";

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  status: string;
  created_at: Date;
}

function toDto(row: UserRow): UserDto {
  return { id: row.id, email: row.email, name: row.name, createdAt: isoReq(row.created_at) };
}

export async function register(input: {
  email: string;
  password: string;
  name: string;
}): Promise<{ user: UserDto; token: string }> {
  const passwordHash = await hashPassword(input.password);
  try {
    const rows = await query<UserRow>(
      `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3)
       RETURNING id, email, name, password_hash, status, created_at`,
      [input.email, input.name, passwordHash],
    );
    const row = rows[0]!;
    return { user: toDto(row), token: signToken(row.id) };
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicate("该邮箱已注册", { field: "email" });
    throw err;
  }
}

/** 登录失败统一提示，不区分"用户不存在"与"口令错误"，避免账号枚举 */
export async function login(input: {
  email: string;
  password: string;
}): Promise<{ user: UserDto; token: string }> {
  const row = await queryOne<UserRow>(
    `SELECT id, email, name, password_hash, status, created_at FROM users WHERE email = $1`,
    [input.email],
  );
  const ok = row ? await verifyPassword(input.password, row.password_hash) : false;
  if (!row || !ok) throw badRequest("邮箱或口令不正确");
  if (row.status !== "active") throw badRequest("账号已停用");
  return { user: toDto(row), token: signToken(row.id) };
}

export async function getUserById(userId: string): Promise<UserDto> {
  const row = await queryOne<UserRow>(
    `SELECT id, email, name, password_hash, status, created_at FROM users WHERE id = $1`,
    [userId],
  );
  if (!row || row.status !== "active") throw notFound("用户不存在");
  return toDto(row);
}
