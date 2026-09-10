import "dotenv/config";
import { resolve } from "node:path";

export interface AppConfig {
  host: string;
  port: number;
  storageDriver: "file" | "postgres" | "memory";
  dataDir: string;
  databaseUrl?: string;
  githubToken?: string;
  githubApiBaseUrl: string;
  githubApiVersion: string;
  githubMaxConcurrency: number;
  githubHistoryDays: number;
  githubMaxItems: number;
  knowledgeWorkerEnabled: boolean;
  redisUrl?: string;
  knowledgeStream: string;
  knowledgeConsumerGroup: string;
  knowledgeConsumerName: string;
  knowledgeWorkerConcurrency: number;
  knowledgeClaimIdleMs: number;
  coreBaseUrl?: string;
  coreServiceToken?: string;
  knowledgeHistoryDays: number;
  knowledgeMaxItems: number;
  knowledgeRepositoryConcurrency: number;
  knowledgeSemanticProvider: "deterministic" | "qoder";
  knowledgeSemanticRequired: boolean;
  qoderCliPath: string;
  qoderModel: string;
  qoderTimeoutSeconds: number;
  qoderMaxOutputTokens: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const storageDriver = env.STORAGE_DRIVER ?? "file";
  if (!isStorageDriver(storageDriver)) {
    throw new Error(`invalid STORAGE_DRIVER ${storageDriver}`);
  }
  const databaseUrl = optional(env.DATABASE_URL);
  if (storageDriver === "postgres" && !databaseUrl) {
    throw new Error("DATABASE_URL is required when STORAGE_DRIVER=postgres");
  }
  const knowledgeWorkerEnabled = boolean(env.KNOWLEDGE_WORKER_ENABLED, false);
  const redisUrl = optional(env.REDIS_URL);
  const coreBaseUrl = optional(env.CORE_BASE_URL)?.replace(/\/+$/, "");
  const coreServiceToken = optional(env.CORE_SERVICE_TOKEN);
  if (knowledgeWorkerEnabled && !redisUrl) {
    throw new Error("REDIS_URL is required when KNOWLEDGE_WORKER_ENABLED=true");
  }
  if (knowledgeWorkerEnabled && !coreBaseUrl) {
    throw new Error("CORE_BASE_URL is required when KNOWLEDGE_WORKER_ENABLED=true");
  }
  if (knowledgeWorkerEnabled && !coreServiceToken) {
    throw new Error("CORE_SERVICE_TOKEN is required when KNOWLEDGE_WORKER_ENABLED=true");
  }
  const semanticProvider = env.KNOWLEDGE_SEMANTIC_PROVIDER ?? "deterministic";
  if (semanticProvider !== "deterministic" && semanticProvider !== "qoder") {
    throw new Error(`invalid KNOWLEDGE_SEMANTIC_PROVIDER ${semanticProvider}`);
  }
  return {
    host: env.HOST ?? "127.0.0.1",
    port: positiveInteger(env.PORT, 8091),
    storageDriver,
    dataDir: resolve(env.DATA_DIR ?? "./data"),
    databaseUrl,
    githubToken: optional(env.GITHUB_TOKEN),
    githubApiBaseUrl: env.GITHUB_API_BASE_URL ?? "https://api.github.com",
    githubApiVersion: env.GITHUB_API_VERSION ?? "2022-11-28",
    githubMaxConcurrency: positiveInteger(env.GITHUB_MAX_CONCURRENCY, 3),
    githubHistoryDays: positiveInteger(env.GITHUB_HISTORY_DAYS, 180),
    githubMaxItems: positiveInteger(env.GITHUB_MAX_ITEMS, 500),
    knowledgeWorkerEnabled,
    redisUrl,
    knowledgeStream: env.KNOWLEDGE_STREAM ?? "knowledge:tasks",
    knowledgeConsumerGroup: env.KNOWLEDGE_CONSUMER_GROUP ?? "knowledge-generators",
    knowledgeConsumerName: env.KNOWLEDGE_CONSUMER_NAME ?? `knowledge-generator-${process.pid}`,
    knowledgeWorkerConcurrency: positiveInteger(env.KNOWLEDGE_WORKER_CONCURRENCY, 1),
    knowledgeClaimIdleMs: positiveInteger(env.KNOWLEDGE_CLAIM_IDLE_MS, 60_000),
    coreBaseUrl,
    coreServiceToken,
    knowledgeHistoryDays: positiveInteger(env.KNOWLEDGE_HISTORY_DAYS, 365),
    knowledgeMaxItems: positiveInteger(env.KNOWLEDGE_MAX_ITEMS, 500),
    knowledgeRepositoryConcurrency: positiveInteger(env.KNOWLEDGE_REPOSITORY_CONCURRENCY, 2),
    knowledgeSemanticProvider: semanticProvider,
    knowledgeSemanticRequired: boolean(env.KNOWLEDGE_SEMANTIC_REQUIRED, false),
    qoderCliPath: env.QODER_CLI_PATH ?? "qodercli",
    qoderModel: env.QODER_KNOWLEDGE_MODEL ?? "Performance",
    qoderTimeoutSeconds: positiveInteger(env.QODER_KNOWLEDGE_TIMEOUT_SECONDS, 600),
    qoderMaxOutputTokens: positiveInteger(env.QODER_KNOWLEDGE_MAX_OUTPUT_TOKENS, 12_000),
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`expected a positive integer, received ${value}`);
  return parsed;
}

function optional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function boolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;
  throw new Error(`expected true|false|1|0, received ${value}`);
}

function isStorageDriver(value: string): value is AppConfig["storageDriver"] {
  return value === "file" || value === "postgres" || value === "memory";
}
