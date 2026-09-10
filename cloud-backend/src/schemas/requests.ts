/**
 * 请求体/查询参数校验（zod）。api 层只做校验与转发，不含业务逻辑。
 * 校验失败统一转 400 VALIDATION_FAILED，details 里给出字段。
 */
import { z, type ZodTypeAny } from "zod";
import { badRequest } from "../lib/errors";

export function parseOrThrow<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const res = schema.safeParse(data);
  if (!res.success) {
    const details: Record<string, string> = {};
    for (const issue of res.error.issues) {
      const key = issue.path.join(".") || "_";
      if (!details[key]) details[key] = issue.message;
    }
    throw badRequest("请求参数校验失败", details);
  }
  return res.data;
}

const email = z.string().trim().min(3).max(254).email("邮箱格式非法");
const password = z.string().min(8, "口令至少 8 位").max(200);
const name = z.string().trim().min(1, "名称不能为空").max(80);
const uuid = z.string().uuid("必须是 uuid");
const nodeId = z.string().trim().min(1).max(400);
const sha = z.string().trim().regex(/^[0-9a-fA-F]{7,40}$/, "commit sha 格式非法");

export const roleSchema = z.enum(["owner", "editor"]);
export const assignableRoleSchema = z.literal("editor");

// ── Auth ──────────────────────────────────────────────────────────────
export const registerBody = z.object({ email, password, name });
export const loginBody = z.object({ email, password: z.string().min(1).max(200) });

// ── Project ───────────────────────────────────────────────────────────
export const createProjectBody = z.object({ name });
export const patchProjectBody = z
  .object({ name: name.optional(), status: z.enum(["active", "archived"]).optional() })
  .refine((v) => v.name !== undefined || v.status !== undefined, {
    message: "至少提供 name 或 status",
  });

// ── 邀请 / 成员 ────────────────────────────────────────────────────────
// 协作邀请固定授予 editor，且永久、无限次使用。
export const createInvitationBody = z.object({});
export const redeemBody = z.object({ key: z.string().trim().min(6).max(120) });
export const patchMemberBody = z.object({ role: assignableRoleSchema });

// ── 仓库绑定 ───────────────────────────────────────────────────────────
export const bindRepositoryBody = z
  .object({
    /**
     * GitHub App 就绪后必填;未就绪时允许省略——worker 改走公开 HTTPS 克隆。
     * 契约 v1.1 向后兼容加法。
     */
    installationId: z.number().int().positive().optional(),
    repoFullName: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, "格式必须是 owner/repo")
      .optional(),
    /** 客户端可直接粘贴仓库地址,服务端解析为 repoFullName */
    repoUrl: z.string().trim().min(1).max(300).optional(),
    branch: z.string().trim().min(1).max(200),
    repositoryId: z.number().int().positive().optional(),
  })
  .transform((v, ctx) => {
    const full = v.repoFullName ?? (v.repoUrl ? parseRepoRef(v.repoUrl) : null);
    if (!full) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repoFullName"],
        message: "需提供 repoFullName(owner/repo)或可解析的 repoUrl",
      });
      return z.NEVER;
    }
    return { ...v, repoFullName: full };
  });

/** 从 https://github.com/owner/repo(.git) 或 owner/repo 解析出 owner/repo */
export function parseRepoRef(input: string): string | null {
  const s = input
    .trim()
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const m = /^(?:https?:\/\/(?:www\.)?github\.com\/)?([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/.exec(s);
  return m?.[1] ?? null;
}

// ── 任务 ──────────────────────────────────────────────────────────────
export const createJobBody = z.object({
  type: z.literal("full").default("full"),
  /** 用户二次确认后强制重算同一 commit，不复用历史图谱。 */
  force: z.boolean().default(false),
  /** 契约外的可选加法：显式指定 SHA（GitHub App 未就绪时用于本地/离线分析） */
  targetCommitSha: sha.optional(),
});

// ── 文档 ──────────────────────────────────────────────────────────────
export const createDocumentBody = z
  .object({
    scope: z.enum(["global", "module"]),
    nodeId: nodeId.optional(),
    title: z.string().trim().min(1).max(200),
    url: z.string().trim().url("必须是合法 URL").max(2000),
    docType: z.enum(["dingtalk", "external", "generated"]).default("external"),
  })
  .refine((v) => v.scope === "global" || Boolean(v.nodeId), {
    message: "scope=module 时必须提供 nodeId",
    path: ["nodeId"],
  });

export const patchDocumentBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    url: z.string().trim().url().max(2000).optional(),
    status: z.enum(["ok", "maybe_stale", "sync_failed"]).optional(),
    changeNote: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.title !== undefined || v.url !== undefined || v.status !== undefined, {
    message: "至少提供 title / url / status 之一",
  });

export const documentQuery = z.object({
  scope: z.enum(["global", "module"]).optional(),
  nodeId: nodeId.optional(),
});

// ── 批注 ──────────────────────────────────────────────────────────────
export const createAnnotationBody = z.object({
  targetKind: z.enum(["node", "edge"]),
  targetId: nodeId,
  body: z.string().trim().min(1, "批注内容不能为空").max(4000),
});

export const patchAnnotationBody = z
  .object({
    body: z.string().trim().min(1).max(4000).optional(),
    resolved: z.boolean().optional(),
  })
  .refine((v) => v.body !== undefined || v.resolved !== undefined, {
    message: "至少提供 body 或 resolved",
  });

export const annotationQuery = z.object({ targetId: nodeId.optional() });

// ── Chat ──────────────────────────────────────────────────────────────
export const chatBody = z.object({
  question: z.string().trim().min(1, "问题不能为空").max(2000),
  nodeId: nodeId.nullish(),
  sessionId: uuid.nullish(),
});

// ── 通用路径参数 ────────────────────────────────────────────────────────
export const projectIdParam = z.object({ id: uuid });
export const versionNoParam = z.object({ id: uuid, no: z.coerce.number().int().min(1) });
export const docIdParam = z.object({ id: uuid, docId: uuid });
export const annIdParam = z.object({ id: uuid, annId: uuid });
export const invIdParam = z.object({ id: uuid, invId: uuid });
export const memberParam = z.object({ id: uuid, userId: uuid });
export const jobIdParam = z.object({ jobId: uuid });
