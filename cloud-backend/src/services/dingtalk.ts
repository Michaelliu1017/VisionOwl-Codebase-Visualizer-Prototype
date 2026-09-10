import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config";
import { query, queryOne, withTx } from "../infra/pg";
import { badRequest, notFound } from "../lib/errors";
import { iso, isoReq } from "../lib/time";
import type { DingtalkAuthTaskDto, DingtalkConnectionDto } from "../types";

const run = promisify(execFile);

interface ConnectionRow {
  id: string;
  user_id: string;
  profile_key: string;
  corp_id: string;
  corp_name: string;
  dingtalk_user_id: string;
  user_name: string;
  status: string;
  is_default: boolean;
  workspace_id: string | null;
  folder_id: string | null;
  last_verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface MutableAuthTask extends DingtalkAuthTaskDto {
  userId: string;
  process?: ChildProcess;
  stdout: string;
  stderr: string;
}

export interface DingtalkDocumentTarget {
  connectionId: string;
  nodeId: string | null;
}

export interface DingtalkPublishResult {
  connectionId: string;
  nodeId: string;
  url: string;
}

const CONNECTION_COLUMNS = `id, user_id, profile_key, corp_id, corp_name, dingtalk_user_id,
  user_name, status, is_default, workspace_id, folder_id, last_verified_at, created_at, updated_at`;
const CONNECTION_COLUMNS_C = `c.id, c.user_id, c.profile_key, c.corp_id, c.corp_name, c.dingtalk_user_id,
  c.user_name, c.status, c.is_default, c.workspace_id, c.folder_id, c.last_verified_at,
  c.created_at, c.updated_at`;

const authTasks = new Map<string, MutableAuthTask>();
const activeTaskByUser = new Map<string, string>();

function toDto(row: ConnectionRow): DingtalkConnectionDto {
  return {
    id: row.id,
    profileKey: row.profile_key,
    corpId: row.corp_id,
    corpName: row.corp_name,
    userId: row.dingtalk_user_id,
    userName: row.user_name,
    status: row.status as DingtalkConnectionDto["status"],
    isDefault: row.is_default,
    workspaceId: row.workspace_id,
    folderId: row.folder_id,
    lastVerifiedAt: iso(row.last_verified_at),
    createdAt: isoReq(row.created_at),
    updatedAt: isoReq(row.updated_at),
  };
}

function taskDto(task: MutableAuthTask): DingtalkAuthTaskDto {
  return {
    taskId: task.taskId,
    status: task.status,
    stage: task.stage,
    authorizationUrl: task.authorizationUrl,
    userCode: task.userCode,
    expiresAt: task.expiresAt,
    connection: task.connection,
    error: task.error,
  };
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function userHome(userId: string): string {
  return path.join(config.dwsCredentialsDir, safeSegment(userId));
}

async function ensureUserHome(userId: string): Promise<string> {
  const home = userHome(userId);
  await fs.mkdir(path.join(home, ".dws"), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(home, ".local", "share"), { recursive: true, mode: 0o700 });
  await fs.chmod(home, 0o700).catch(() => undefined);
  return home;
}

async function dwsEnv(userId: string): Promise<NodeJS.ProcessEnv> {
  const home = await ensureUserHome(userId);
  return {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    DWS_CONFIG_DIR: path.join(home, ".dws"),
    DWS_DISABLE_KEYCHAIN: "1",
    NO_COLOR: "1",
    TERM: "dumb",
  };
}

export function parseDwsAuthorizationOutput(raw: string): {
  authorizationUrl: string | null;
  userCode: string | null;
} {
  const clean = raw.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  const urls = [...clean.matchAll(/https?:\/\/[^\s│]+/g)]
    .map((match) => match[0].replace(/[),，。]+$/, ""));
  const codes = [...clean.matchAll(/(?:授权码|user[_ -]?code)\s*[:：]\s*([A-Z0-9-]{4,})/gi)];
  const code = codes.at(-1)?.[1] ?? null;
  const authorizationUrl = [...urls].reverse().find((url) => /[?#]/.test(url)) ?? urls.at(-1) ?? null;
  return { authorizationUrl, userCode: code };
}

export function extractDwsJson(raw: string): Record<string, unknown> | null {
  const clean = raw.trim();
  const starts: number[] = [];
  for (let index = 0; index < clean.length; index += 1) {
    if (clean[index] === "{") starts.push(index);
  }
  for (const start of starts) {
    try {
      const parsed = JSON.parse(clean.slice(start)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function findString(value: unknown, keys: Set<string>): string | null {
  if (!value || typeof value !== "object") return null;
  for (const [key, nested] of Object.entries(value)) {
    if (keys.has(key) && typeof nested === "string" && nested.trim()) return nested.trim();
  }
  for (const nested of Object.values(value)) {
    const found = findString(nested, keys);
    if (found) return found;
  }
  return null;
}

function scrub(text: string): string {
  return text
    .replace(/(access|refresh)[_-]?token["'=:\s]+[^\s",}]+/gi, "$1_token=***")
    .replace(/gh[pousr]_[A-Za-z0-9]{10,}/g, "gh*_***");
}

async function upsertConnection(userId: string, payload: Record<string, unknown>): Promise<DingtalkConnectionDto> {
  const corpId = String(payload.corp_id ?? payload.corpId ?? "").trim();
  const dingtalkUserId = String(payload.user_id ?? payload.userId ?? "").trim();
  if (!corpId || !dingtalkUserId) throw new Error("DWS 登录成功但未返回完整组织与用户身份");
  const corpName = String(payload.corp_name ?? payload.corpName ?? "").trim();
  const userName = String(payload.user_name ?? payload.userName ?? "").trim();
  const profileKey = `${corpId}:${dingtalkUserId}`;

  const id = await withTx(async (client) => {
    await client.query(`UPDATE dingtalk_connections SET is_default = false WHERE user_id = $1`, [userId]);
    const result = await client.query<{ id: string }>(
      `INSERT INTO dingtalk_connections
         (user_id, profile_key, corp_id, corp_name, dingtalk_user_id, user_name,
          status, is_default, last_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', true, now())
       ON CONFLICT (user_id, profile_key) DO UPDATE
         SET corp_name = EXCLUDED.corp_name,
             user_name = EXCLUDED.user_name,
             status = 'active',
             is_default = true,
             last_verified_at = now(),
             updated_at = now()
       RETURNING id`,
      [userId, profileKey, corpId, corpName, dingtalkUserId, userName],
    );
    return result.rows[0]!.id;
  });
  return getConnection(userId, id);
}

function updateAuthProgress(task: MutableAuthTask, chunk: string): void {
  task.stderr = `${task.stderr}${chunk}`.slice(-24_000);
  const parsed = parseDwsAuthorizationOutput(task.stderr);
  if (parsed.authorizationUrl) task.authorizationUrl = parsed.authorizationUrl;
  if (parsed.userCode) task.userCode = parsed.userCode;
  if (task.authorizationUrl || task.userCode) task.stage = "waiting_authorization";
}

export async function startDingtalkAuth(userId: string): Promise<DingtalkAuthTaskDto> {
  const activeId = activeTaskByUser.get(userId);
  const active = activeId ? authTasks.get(activeId) : null;
  if (active && (active.status === "pending" || active.status === "waiting")) return taskDto(active);

  const taskId = randomUUID();
  const task: MutableAuthTask = {
    taskId,
    userId,
    status: "pending",
    stage: "starting",
    authorizationUrl: null,
    userCode: null,
    expiresAt: new Date(Date.now() + 16 * 60_000).toISOString(),
    connection: null,
    error: null,
    stdout: "",
    stderr: "",
  };
  authTasks.set(taskId, task);
  activeTaskByUser.set(userId, taskId);

  const child = spawn(
    config.dwsCliPath,
    ["--format", "json", "--yes", "auth", "login", "--device", "--no-browser", "--recommend"],
    { env: await dwsEnv(userId), stdio: ["ignore", "pipe", "pipe"] },
  );
  task.process = child;
  task.status = "waiting";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    task.stdout = `${task.stdout}${chunk}`.slice(-48_000);
  });
  child.stderr.on("data", (chunk: string) => updateAuthProgress(task, chunk));

  let settled = false;
  const finishFailed = (message: string) => {
    if (settled) return;
    settled = true;
    task.status = "failed";
    task.stage = "failed";
    task.error = scrub(message).slice(0, 500);
    activeTaskByUser.delete(userId);
  };
  child.on("error", (error) => finishFailed(`无法启动 DWS：${error.message}`));
  child.on("close", (code) => {
    if (settled) return;
    if (code !== 0) {
      finishFailed(task.stderr.trim() || `DWS 登录退出码 ${code ?? "unknown"}`);
      return;
    }
    void (async () => {
      try {
        const payload = extractDwsJson(task.stdout);
        if (!payload || payload.success !== true) throw new Error("DWS 未返回有效登录结果");
        task.connection = await upsertConnection(userId, payload);
        task.status = "succeeded";
        task.stage = "completed";
        task.error = null;
        settled = true;
        activeTaskByUser.delete(userId);
      } catch (error) {
        finishFailed(error instanceof Error ? error.message : String(error));
      }
    })();
  });

  setTimeout(() => {
    if (task.status !== "pending" && task.status !== "waiting") return;
    task.process?.kill("SIGTERM");
    finishFailed("钉钉授权已超时，请重新发起连接");
  }, 16 * 60_000 + 5_000).unref();
  setTimeout(() => authTasks.delete(taskId), 30 * 60_000).unref();
  return taskDto(task);
}

export function getDingtalkAuthTask(userId: string, taskId: string): DingtalkAuthTaskDto {
  const task = authTasks.get(taskId);
  if (!task || task.userId !== userId) throw notFound("钉钉授权任务不存在或已过期");
  return taskDto(task);
}

export async function listConnections(userId: string): Promise<DingtalkConnectionDto[]> {
  const rows = await query<ConnectionRow>(
    `SELECT ${CONNECTION_COLUMNS} FROM dingtalk_connections
      WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC`,
    [userId],
  );
  return rows.map(toDto);
}

async function getConnectionRow(userId: string, connectionId: string): Promise<ConnectionRow> {
  const row = await queryOne<ConnectionRow>(
    `SELECT ${CONNECTION_COLUMNS} FROM dingtalk_connections WHERE id = $1 AND user_id = $2`,
    [connectionId, userId],
  );
  if (!row) throw notFound("钉钉身份不存在");
  return row;
}

export async function getConnection(userId: string, connectionId: string): Promise<DingtalkConnectionDto> {
  return toDto(await getConnectionRow(userId, connectionId));
}

export async function selectConnection(userId: string, connectionId: string): Promise<DingtalkConnectionDto> {
  await getConnectionRow(userId, connectionId);
  await withTx(async (client) => {
    await client.query(`UPDATE dingtalk_connections SET is_default = false WHERE user_id = $1`, [userId]);
    await client.query(
      `UPDATE dingtalk_connections SET is_default = true, updated_at = now() WHERE id = $1 AND user_id = $2`,
      [connectionId, userId],
    );
  });
  return getConnection(userId, connectionId);
}

export async function updateConnection(
  userId: string,
  connectionId: string,
  input: { workspaceId?: string | null; folderId?: string | null },
): Promise<DingtalkConnectionDto> {
  await getConnectionRow(userId, connectionId);
  await query(
    `UPDATE dingtalk_connections
        SET workspace_id = $3, folder_id = $4, updated_at = now()
      WHERE id = $1 AND user_id = $2`,
    [connectionId, userId, input.workspaceId?.trim() || null, input.folderId?.trim() || null],
  );
  return getConnection(userId, connectionId);
}

async function runDwsJson(userId: string, args: string[]): Promise<Record<string, unknown>> {
  try {
    const { stdout } = await run(
      config.dwsCliPath,
      ["--format", "json", "--yes", "--timeout", String(config.dwsCommandTimeoutSeconds), ...args],
      {
        env: await dwsEnv(userId),
        timeout: config.dwsCommandTimeoutSeconds * 1000,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    const parsed = extractDwsJson(stdout);
    if (!parsed) throw new Error("DWS 返回内容无法解析");
    return parsed;
  } catch (error) {
    const detail = error as Error & { stderr?: string; stdout?: string };
    const message = scrub(detail.stderr || detail.stdout || detail.message || String(error)).trim();
    throw new Error(message.slice(0, 900) || "DWS 调用失败");
  }
}

export async function disconnectConnection(userId: string, connectionId: string): Promise<void> {
  const row = await getConnectionRow(userId, connectionId);
  await runDwsJson(userId, ["--profile", row.profile_key, "auth", "logout"]).catch(() => undefined);
  await query(`DELETE FROM dingtalk_connections WHERE id = $1 AND user_id = $2`, [connectionId, userId]);
  const remaining = await queryOne<{ count: string }>(
    `SELECT count(*)::text AS count FROM dingtalk_connections WHERE user_id = $1`,
    [userId],
  );
  if (Number(remaining?.count ?? 0) === 0) {
    await fs.rm(userHome(userId), { recursive: true, force: true }).catch(() => undefined);
  } else if (row.is_default) {
    const next = await queryOne<{ id: string }>(
      `SELECT id FROM dingtalk_connections WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    if (next) await selectConnection(userId, next.id);
  }
}

export async function getDefaultConnection(userId: string): Promise<DingtalkConnectionDto | null> {
  const row = await queryOne<ConnectionRow>(
    `SELECT ${CONNECTION_COLUMNS} FROM dingtalk_connections
      WHERE user_id = $1 AND is_default = true AND status = 'active'
      ORDER BY updated_at DESC LIMIT 1`,
    [userId],
  );
  return row ? toDto(row) : null;
}

export async function getProjectOwnerConnection(projectId: string): Promise<DingtalkConnectionDto | null> {
  const row = await queryOne<ConnectionRow>(
    `SELECT ${CONNECTION_COLUMNS_C}
       FROM projects p
       JOIN dingtalk_connections c
         ON c.user_id = p.owner_id AND c.is_default = true AND c.status = 'active'
      WHERE p.id = $1 LIMIT 1`,
    [projectId],
  );
  return row ? toDto(row) : null;
}

async function getConnectionById(connectionId: string): Promise<ConnectionRow> {
  const row = await queryOne<ConnectionRow>(
    `SELECT ${CONNECTION_COLUMNS} FROM dingtalk_connections WHERE id = $1`,
    [connectionId],
  );
  if (!row) throw badRequest("钉钉身份已解绑，请重新选择身份");
  if (row.status !== "active") throw badRequest("钉钉身份授权已失效，请重新授权");
  return row;
}

async function markReauthRequired(connectionId: string): Promise<void> {
  await query(
    `UPDATE dingtalk_connections SET status = 'reauth_required', updated_at = now() WHERE id = $1`,
    [connectionId],
  ).catch(() => undefined);
}

export async function publishDingtalkDocument(input: {
  connectionId: string;
  title: string;
  markdown: string;
  existingNodeId?: string | null;
}): Promise<DingtalkPublishResult> {
  const connection = await getConnectionById(input.connectionId);
  await fs.mkdir(config.workspaceDir, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(config.workspaceDir, "dws-doc-"));
  const markdownFile = path.join(temporary, "document.md");
  await fs.writeFile(markdownFile, input.markdown, "utf8");
  try {
    let nodeId = input.existingNodeId?.trim() || "";
    if (nodeId) {
      await runDwsJson(connection.user_id, [
        "--profile", connection.profile_key,
        "doc", "update",
        "--node", nodeId,
        "--content-file", markdownFile,
        "--mode", "overwrite",
      ]);
    } else {
      const args = [
        "--profile", connection.profile_key,
        "doc", "create",
        "--name", input.title,
        "--content-file", markdownFile,
      ];
      if (connection.folder_id) args.push("--folder", connection.folder_id);
      else if (connection.workspace_id) args.push("--workspace", connection.workspace_id);
      const created = await runDwsJson(connection.user_id, args);
      nodeId = findString(created, new Set(["nodeId", "node_id"])) ?? "";
      if (!nodeId) throw new Error("钉钉已响应创建请求，但未返回文档 nodeId");
    }

    await runDwsJson(connection.user_id, [
      "--profile", connection.profile_key,
      "doc", "read",
      "--node", nodeId,
      "--content-format", "markdown",
    ]);
    await query(
      `UPDATE dingtalk_connections SET status = 'active', last_verified_at = now(), updated_at = now()
        WHERE id = $1`,
      [connection.id],
    );
    return {
      connectionId: connection.id,
      nodeId,
      url: `https://alidocs.dingtalk.com/i/nodes/${encodeURIComponent(nodeId)}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/auth|token|登录|授权|unauthenticated|permission/i.test(message)) {
      await markReauthRequired(connection.id);
    }
    throw new Error(`钉钉文档同步失败：${message}`);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}
