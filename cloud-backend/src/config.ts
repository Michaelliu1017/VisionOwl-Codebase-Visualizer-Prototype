/**
 * 环境变量解析与校验。启动即失败原则：缺关键变量直接退出，不带默认密钥上线。
 */
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

function str(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`缺少必需环境变量 ${key}（参考 .env.example）`);
  }
  return v;
}

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`环境变量 ${key} 必须是数字，实际为 ${v}`);
  return n;
}

function bool(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value === undefined || value === "") return fallback;
  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;
  throw new Error(`环境变量 ${key} 必须是 true|false|1|0，实际为 ${value}`);
}

export type AnalyzerMode = "demo" | "local" | "runner";
export type ArtifactStorage = "local" | "oss";
export type AgentOrchestrationMode = "adaptive" | "legacy_multi";

function analyzerMode(): AnalyzerMode {
  const v = str("ANALYZER_MODE", "demo");
  if (v !== "demo" && v !== "local" && v !== "runner") {
    throw new Error(`ANALYZER_MODE 只能是 demo|local|runner，实际为 ${v}`);
  }
  return v;
}

function artifactStorage(): ArtifactStorage {
  const value = str("ARTIFACT_STORAGE", "local");
  if (value !== "local" && value !== "oss") {
    throw new Error(`ARTIFACT_STORAGE 只能是 local|oss，实际为 ${value}`);
  }
  return value;
}

function agentOrchestrationMode(): AgentOrchestrationMode {
  const value = str("AGENT_ORCHESTRATION_MODE", "adaptive");
  if (value !== "adaptive" && value !== "legacy_multi") {
    throw new Error(
      `AGENT_ORCHESTRATION_MODE 只能是 adaptive|legacy_multi，实际为 ${value}`,
    );
  }
  return value;
}

const jwtSecret = str("JWT_SECRET", process.env.NODE_ENV === "production" ? undefined : "dev-only-insecure-secret-change-me");
if (process.env.NODE_ENV === "production" && jwtSecret.length < 32) {
  throw new Error("生产环境 JWT_SECRET 必须 ≥32 字节：openssl rand -hex 32");
}

const knowledgeIntegrationEnabled = bool("KNOWLEDGE_INTEGRATION_ENABLED", false);
const integrationServiceToken = str(
  "INTEGRATION_SERVICE_TOKEN",
  knowledgeIntegrationEnabled
    ? process.env.NODE_ENV === "production" ? undefined : "dev-only-integration-token-change-me"
    : "",
);
if (
  knowledgeIntegrationEnabled &&
  process.env.NODE_ENV === "production" &&
  integrationServiceToken.length < 32
) {
  throw new Error("生产环境 INTEGRATION_SERVICE_TOKEN 必须 ≥32 字节");
}

export const config = {
  env: str("NODE_ENV", "development"),
  isProd: str("NODE_ENV", "development") === "production",
  port: num("PORT", 17800),
  logLevel: str("LOG_LEVEL", "info"),
  publicBaseUrl: str("PUBLIC_BASE_URL", "http://127.0.0.1:8080").replace(/\/+$/, ""),
  corsOrigin: str("CORS_ORIGIN", "*"),

  databaseUrl: str("DATABASE_URL", "postgres://visionowl:visionowl@127.0.0.1:5432/visionowl"),
  redisUrl: str("REDIS_URL", "redis://127.0.0.1:6379"),
  artifactsDir: path.resolve(str("ARTIFACTS_DIR", path.join(process.cwd(), ".artifacts"))),
  artifactStorage: artifactStorage(),
  ossRegion: str("OSS_REGION", ""),
  ossEndpoint: str("OSS_ENDPOINT", ""),
  ossBucket: str("OSS_BUCKET", ""),
  ossAccessKeyId: str("OSS_ACCESS_KEY_ID", ""),
  ossAccessKeySecret: str("OSS_ACCESS_KEY_SECRET", ""),
  ossStsToken: str("OSS_STS_TOKEN", ""),

  jwtSecret,
  jwtTtlDays: num("JWT_TTL_DAYS", 7),
  loginRateMax: num("LOGIN_RATE_MAX", 5),
  loginRateWindow: str("LOGIN_RATE_WINDOW", "1 minute"),
  chatRateMax: num("CHAT_RATE_MAX", 20),
  chatRateWindow: str("CHAT_RATE_WINDOW", "1 minute"),
  chatAnswerCacheTtlSeconds: num("CHAT_ANSWER_CACHE_TTL_SECONDS", 24 * 3600),

  knowledgeIntegrationEnabled,
  integrationServiceToken,
  integrationArtifactMaxBytes: num("INTEGRATION_ARTIFACT_MAX_BYTES", 25 * 1024 * 1024),
  integrationDispatchIntervalSeconds: num("INTEGRATION_DISPATCH_INTERVAL_SECONDS", 30),
  knowledgeRunTimeoutSeconds: num("KNOWLEDGE_RUN_TIMEOUT_SECONDS", 1800),
  skillLabRunTimeoutSeconds: num("SKILLLAB_RUN_TIMEOUT_SECONDS", 3600),
  knowledgeAutoGenerate: bool("KNOWLEDGE_AUTO_GENERATE", false),
  skillLabAutoOptimize: bool("SKILLLAB_AUTO_OPTIMIZE", false),
  skillLabEvaluationDatasetRef: str("SKILLLAB_EVALUATION_DATASET_REF", "project-history:v1"),
  skillLabMaxRounds: num("SKILLLAB_MAX_ROUNDS", 5),
  skillLabMaxPatchesPerRound: num("SKILLLAB_MAX_PATCHES_PER_ROUND", 3),
  skillLabSourceArchiveMaxBytes: num("SKILLLAB_SOURCE_ARCHIVE_MAX_BYTES", 100 * 1024 * 1024),

  jobDebounceSeconds: num("JOB_DEBOUNCE_SECONDS", 30),
  workerConcurrency: num("WORKER_CONCURRENCY", 3),
  repositoryScanMaxAttempts: num("REPOSITORY_SCAN_MAX_ATTEMPTS", 3),
  jobTimeoutFull: num("JOB_TIMEOUT_FULL", 1200),
  jobTimeoutIncremental: num("JOB_TIMEOUT_INCREMENTAL", 600),

  analyzerMode: analyzerMode(),
  runnerImage: str("RUNNER_IMAGE", "visionowl-runner:latest"),
  runnerNetwork: str("RUNNER_NETWORK", "runner-net"),
  runnerMemory: str("RUNNER_MEMORY", "4g"),
  runnerCpus: num("RUNNER_CPUS", 2),
  workspaceDir: path.resolve(str("WORKSPACE_DIR", path.join(process.cwd(), ".workspace"))),
  sourceCacheTtlSeconds: num("SOURCE_CACHE_TTL_SECONDS", 24 * 3600),
  maxTurnsFull: num("MAX_TURNS_FULL", 50),
  maxTurnsIncremental: num("MAX_TURNS_INCREMENTAL", 25),

  githubAppId: str("GITHUB_APP_ID", ""),
  githubAppSlug: str("GITHUB_APP_SLUG", ""),
  githubAppPrivateKeyPath: str("GITHUB_APP_PRIVATE_KEY_PATH", ""),
  githubWebhookSecret: str("GITHUB_WEBHOOK_SECRET", ""),

  qoderPat: str("QODER_PERSONAL_ACCESS_TOKEN", ""),
  agentOrchestrationMode: agentOrchestrationMode(),
  qoderModuleModel: str("QODER_MODULE_MODEL", "Performance"),
  qoderSynthesisModel: str("QODER_SYNTHESIS_MODEL", "Performance"),
  qoderSynthesisMaxTurns: num("QODER_SYNTHESIS_MAX_TURNS", 12),
  adaptiveSingleAgentMaxPackets: num("ADAPTIVE_SINGLE_AGENT_MAX_PACKETS", 8),
  adaptiveMaxAgents: num("ADAPTIVE_MAX_AGENTS", 4),
  adaptivePacketsPerAgent: num("ADAPTIVE_PACKETS_PER_AGENT", 5),
  moduleAgentConcurrency: num("MODULE_AGENT_CONCURRENCY", 3),
  moduleAgentMaxTasks: num("MODULE_AGENT_MAX_TASKS", 24),
  moduleAgentTimeoutSeconds: num("MODULE_AGENT_TIMEOUT_SECONDS", 300),
  moduleAgentMaxOutputTokens: num("MODULE_AGENT_MAX_OUTPUT_TOKENS", 4000),
  moduleAgentContextMaxBytes: num("MODULE_AGENT_CONTEXT_MAX_BYTES", 60000),
  moduleAgentContextMaxFiles: num("MODULE_AGENT_CONTEXT_MAX_FILES", 24),
  moduleAgentRepairEnabled: bool("MODULE_AGENT_REPAIR_ENABLED", true),
  qoderModuleRepairModel: str("QODER_MODULE_REPAIR_MODEL", ""),
  moduleAgentRepairMaxOutputTokens: num("MODULE_AGENT_REPAIR_MAX_OUTPUT_TOKENS", 4000),
  moduleAgentRepairMaxCandidateBytes: num("MODULE_AGENT_REPAIR_MAX_CANDIDATE_BYTES", 60000),
  qoderChatModel: str("QODER_CHAT_MODEL", "DeepSeek-V4-Flash"),
  qoderChatMaxTurns: num("QODER_CHAT_MAX_TURNS", 5),
  qoderChatMaxOutputTokens: num("QODER_CHAT_MAX_OUTPUT_TOKENS", 1200),
  qoderChatQueueTimeoutSeconds: num("QODER_CHAT_QUEUE_TIMEOUT_SECONDS", 120),
  qoderChatTimeoutSeconds: num("QODER_CHAT_TIMEOUT_SECONDS", 240),

  dwsCliPath: str("DWS_CLI_PATH", "dws"),
  dwsCredentialsDir: path.resolve(str("DWS_CREDENTIALS_DIR", "/data/dws")),
  dwsCommandTimeoutSeconds: num("DWS_COMMAND_TIMEOUT_SECONDS", 180),

  /** 契约版本，随每个响应回传 X-Contract-Version */
  contractVersion: "1.0",
  serviceVersion: "cloud-0.1.0",
} as const;

if (
  config.artifactStorage === "oss" &&
  (!config.ossBucket ||
    (!config.ossEndpoint && !config.ossRegion) ||
    !config.ossAccessKeyId ||
    !config.ossAccessKeySecret)
) {
  throw new Error(
    "ARTIFACT_STORAGE=oss 时必须配置 OSS_BUCKET、OSS_REGION/OSS_ENDPOINT 与 OSS 访问凭证",
  );
}

/** 是否已具备真实 GitHub App 能力（否则 repository 接口返回 mock，契约 §4.4 允许） */
export const githubAppReady = (): boolean =>
  Boolean(config.githubAppId && config.githubAppPrivateKeyPath);
