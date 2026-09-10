/**
 * 图谱产物存储（开发可用本地 ARTIFACTS_DIR；生产可切换 OSS，artifactUrl 语义不变）
 * 路径规约：{projectId}/{commitSha}/graph.json —— 与 spec §11.1 的 OSS key 同构
 *
 * 安全：所有 key 只允许 [A-Za-z0-9._-] 与单层 "/"，写读前统一做穿越校验。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { internal, notFound } from "../lib/errors";

interface OssClient {
  put(key: string, content: Buffer): Promise<unknown>;
  get(key: string): Promise<{ content: Buffer | string }>;
  head(key: string): Promise<unknown>;
}

type OssConstructor = new (options: Record<string, unknown>) => OssClient;
const OSS = require("ali-oss") as OssConstructor;

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
let ossClient: OssClient | null = null;

function objectStore(): OssClient {
  if (!ossClient) {
    ossClient = new OSS({
      region: config.ossRegion || undefined,
      endpoint: config.ossEndpoint || undefined,
      bucket: config.ossBucket,
      accessKeyId: config.ossAccessKeyId,
      accessKeySecret: config.ossAccessKeySecret,
      stsToken: config.ossStsToken || undefined,
      secure: true,
    });
  }
  return ossClient;
}

function validateKey(key: string): string {
  const segments = key.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) throw internal("产物 key 为空");
  for (const segment of segments) {
    if (!SAFE_SEGMENT.test(segment)) throw internal(`产物 key 含非法片段：${segment}`);
  }
  return segments.join("/");
}

export function artifactKey(projectId: string, commitSha: string, file = "graph.json"): string {
  return `visionowl/${projectId}/${commitSha}/${file}`;
}

/** 扩展模块上传区：Core 根据 runId 分配前缀，回调只能引用该前缀内的产物。 */
export function integrationArtifactKey(projectId: string, runId: string, fileName: string): string {
  if (!SAFE_SEGMENT.test(projectId) || !SAFE_SEGMENT.test(runId) || !SAFE_SEGMENT.test(fileName)) {
    throw internal("集成产物标识含非法字符");
  }
  return `visionowl/integrations/${projectId}/${runId}/${fileName}`;
}

/** 把相对 key 解析为绝对路径，拒绝任何越出 ARTIFACTS_DIR 的路径 */
export function resolveArtifact(key: string): string {
  const segments = validateKey(key).split("/");
  const abs = path.resolve(config.artifactsDir, segments.join(path.sep));
  const root = path.resolve(config.artifactsDir);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw internal("产物路径越界");
  }
  return abs;
}

export async function writeArtifact(key: string, content: string | Buffer): Promise<void> {
  const safeKey = validateKey(key);
  if (config.artifactStorage === "oss") {
    await objectStore().put(safeKey, Buffer.isBuffer(content) ? content : Buffer.from(content));
    return;
  }
  const abs = resolveArtifact(key);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

export async function writeJsonArtifact(key: string, value: unknown): Promise<void> {
  await writeArtifact(key, JSON.stringify(value, null, 2));
}

export async function readArtifact(key: string): Promise<Buffer> {
  const safeKey = validateKey(key);
  if (config.artifactStorage === "oss") {
    try {
      const result = await objectStore().get(safeKey);
      return Buffer.isBuffer(result.content) ? result.content : Buffer.from(result.content);
    } catch {
      throw notFound("图谱产物不存在");
    }
  }
  const abs = resolveArtifact(key);
  try {
    return await fs.readFile(abs);
  } catch {
    throw notFound("图谱产物不存在");
  }
}

export async function readJsonArtifact<T = unknown>(key: string): Promise<T> {
  const buf = await readArtifact(key);
  try {
    return JSON.parse(buf.toString("utf8")) as T;
  } catch {
    throw internal("图谱产物不是合法 JSON");
  }
}

export async function artifactExists(key: string): Promise<boolean> {
  const safeKey = validateKey(key);
  if (config.artifactStorage === "oss") {
    try {
      await objectStore().head(safeKey);
      return true;
    } catch {
      return false;
    }
  }
  try {
    await fs.access(resolveArtifact(key));
    return true;
  } catch {
    return false;
  }
}

export async function ensureArtifactsDir(): Promise<void> {
  if (config.artifactStorage === "oss") return;
  await fs.mkdir(config.artifactsDir, { recursive: true });
}
