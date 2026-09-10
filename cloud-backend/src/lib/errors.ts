/**
 * 统一错误规约（协同开发.md §3.1）
 * 任何非 2xx 响应体：{ "error": { "code", "message", "details" } }
 */

export type ErrorCode =
  | "VALIDATION_FAILED"
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "DUPLICATE"
  | "INVITATION_INVALID"
  | "RATE_LIMITED"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  DUPLICATE: 409,
  INVITATION_INVALID: 410,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = STATUS[code];
    this.details = details;
  }

  toBody(): { error: { code: ErrorCode; message: string; details: Record<string, unknown> } } {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new AppError("VALIDATION_FAILED", message, details);

export const authRequired = (message = "未登录或 token 已过期") =>
  new AppError("AUTH_REQUIRED", message);

export const forbidden = (message = "角色权限不足") => new AppError("FORBIDDEN", message);

/** 无权可见的资源也一律 404，防枚举（契约 §3.1） */
export const notFound = (message = "资源不存在") => new AppError("NOT_FOUND", message);

export const duplicate = (message: string, details?: Record<string, unknown>) =>
  new AppError("DUPLICATE", message, details);

export const invitationInvalid = (message = "邀请密钥无效或已撤销") =>
  new AppError("INVITATION_INVALID", message);

export const rateLimited = (message = "请求过于频繁") => new AppError("RATE_LIMITED", message);

export const internal = (message = "服务内部错误") => new AppError("INTERNAL", message);
