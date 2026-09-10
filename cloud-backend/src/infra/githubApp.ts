/**
 * GitHub App 集成（spec §4.2）
 * 权限最小化：contents:read + push webhook。绝不保存用户 PAT/密码/SSH 私钥。
 * Installation Token 每任务现签（约 1h），仅在内存中流转。
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import jwt from "jsonwebtoken";
import { config, githubAppReady } from "../config";
import { internal } from "../lib/errors";

const GITHUB_API = "https://api.github.com";

/** 安装入口：Owner 点击后跳转 GitHub 安装页，state 带回 projectId */
export function installUrl(projectId: string): string {
  const slug = config.githubAppSlug || "visionowl";
  const state = Buffer.from(JSON.stringify({ projectId }), "utf8").toString("base64url");
  return `https://github.com/apps/${slug}/installations/new?state=${state}`;
}

export function parseInstallState(state: unknown): { projectId: string } | null {
  if (typeof state !== "string" || !state) return null;
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as {
      projectId?: unknown;
    };
    return typeof parsed.projectId === "string" ? { projectId: parsed.projectId } : null;
  } catch {
    return null;
  }
}

function privateKey(): string {
  if (!config.githubAppPrivateKeyPath) throw internal("GITHUB_APP_PRIVATE_KEY_PATH 未配置");
  try {
    return fs.readFileSync(config.githubAppPrivateKeyPath, "utf8");
  } catch {
    throw internal("无法读取 GitHub App 私钥（检查路径与 600 权限）");
  }
}

/** App 级 JWT：10 分钟内有效，仅用于换取 Installation Token */
function appJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iat: now - 30, exp: now + 540, iss: config.githubAppId },
    privateKey(),
    { algorithm: "RS256" },
  );
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

/** 每任务现签短时效 token；调用方用完即弃，禁止落库/落日志 */
export async function createInstallationToken(installationId: number): Promise<InstallationToken> {
  if (!githubAppReady()) throw internal("GitHub App 未配置，无法签发 Installation Token");
  const res = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appJwt()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "visionowl-cloud",
    },
  });
  if (!res.ok) {
    throw internal(`签发 Installation Token 失败：HTTP ${res.status}`);
  }
  const body = (await res.json()) as { token?: string; expires_at?: string };
  if (!body.token) throw internal("GitHub 未返回 Installation Token");
  return { token: body.token, expiresAt: body.expires_at ?? "" };
}

/** 查询安装可访问的仓库（绑定页选仓库用） */
export async function listInstallationRepos(
  installationId: number,
): Promise<Array<{ id: number; fullName: string; defaultBranch: string; private: boolean }>> {
  const { token } = await createInstallationToken(installationId);
  const res = await fetch(`${GITHUB_API}/installation/repositories?per_page=100`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "visionowl-cloud",
    },
  });
  if (!res.ok) throw internal(`拉取安装仓库列表失败：HTTP ${res.status}`);
  const body = (await res.json()) as {
    repositories?: Array<{ id: number; full_name: string; default_branch: string; private: boolean }>;
  };
  return (body.repositories ?? []).map((r) => ({
    id: r.id,
    fullName: r.full_name,
    defaultBranch: r.default_branch,
    private: r.private,
  }));
}

/** 取分支当前 head SHA（手动触发全量任务时确定 target_commit_sha） */
export async function getBranchHeadSha(
  installationId: number,
  repoFullName: string,
  branch: string,
): Promise<string> {
  const { token } = await createInstallationToken(installationId);
  const res = await fetch(
    `${GITHUB_API}/repos/${repoFullName}/commits/${encodeURIComponent(branch)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "visionowl-cloud",
      },
    },
  );
  if (!res.ok) throw internal(`获取分支 head 失败：HTTP ${res.status}`);
  const body = (await res.json()) as { sha?: string };
  if (!body.sha) throw internal("GitHub 未返回 commit sha");
  return body.sha;
}

/**
 * 为受信任的内部 Worker 提供冻结源码 ZIP。私有仓库使用短时 Installation
 * Token，公开仓库直连 codeload；Token 只在本次请求内存中存在。
 */
export async function downloadRepositoryArchive(
  repoFullName: string,
  commitSha: string,
  installationId: number | null,
  maxBytes: number,
): Promise<Buffer> {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repoFullName)) {
    throw internal("仓库名称格式非法");
  }
  if (!/^[0-9a-fA-F]{7,64}$/.test(commitSha)) {
    throw internal("源码快照 commit SHA 格式非法");
  }
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "visionowl-cloud",
  };
  let url = `https://codeload.github.com/${repoFullName}/zip/${commitSha}`;
  if (installationId !== null) {
    const { token } = await createInstallationToken(installationId);
    headers.Authorization = `Bearer ${token}`;
    url = `${GITHUB_API}/repos/${repoFullName}/zipball/${commitSha}`;
  }
  const response = await fetch(url, { headers, redirect: "follow" });
  if (!response.ok || !response.body) {
    throw internal(`下载源码快照失败：HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw internal("源码快照超过大小限制");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw internal("源码快照超过大小限制");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

/**
 * Webhook 验签：必须使用**原始请求正文**做 HMAC-SHA256（spec §12-5）
 * 未配置密钥时返回 false —— 绝不静默放行。
 */
export function verifyWebhookSignature(rawBody: Buffer, signatureHeader: unknown): boolean {
  if (!config.githubWebhookSecret) return false;
  if (typeof signatureHeader !== "string" || !signatureHeader.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", config.githubWebhookSecret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signatureHeader, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface PushEvent {
  repoFullName: string;
  branch: string;
  headSha: string;
  beforeSha: string | null;
  deleted: boolean;
}

export function parsePushEvent(payload: unknown): PushEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as {
    ref?: unknown;
    after?: unknown;
    before?: unknown;
    deleted?: unknown;
    repository?: { full_name?: unknown };
  };
  if (typeof p.ref !== "string" || !p.ref.startsWith("refs/heads/")) return null;
  if (typeof p.after !== "string" || !p.after) return null;
  const repoFullName = p.repository?.full_name;
  if (typeof repoFullName !== "string" || !repoFullName) return null;
  const before = typeof p.before === "string" && /^[0-9a-f]{7,40}$/.test(p.before) && !/^0+$/.test(p.before)
    ? p.before
    : null;
  return {
    repoFullName,
    branch: p.ref.slice("refs/heads/".length),
    headSha: p.after,
    beforeSha: before,
    deleted: p.deleted === true,
  };
}
