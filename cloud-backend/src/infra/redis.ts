/**
 * Redis 访问层：任务队列(Stream)、分布式锁、去抖、事件 pub/sub 背板。
 *
 * 韧性约定：Redis 不可用时不得打挂 REST 链路——
 * 事件发布失败只记日志并退化为本进程内 SSE 广播；
 * 只有队列相关操作（入队/消费）会显式向上抛错。
 */
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { config } from "../config";

export const KEYS = {
  /** 任务流 + 消费组（spec §10） */
  stream: "scan:tasks",
  group: "workers",
  knowledgeStream: "knowledge:tasks",
  skillLabStream: "skilllab:tasks",
  queuedJob: (jobId: string) => `queue:job:${jobId}`,
  queuedRepositoryScan: (scanId: string) => `queue:repository-scan:${scanId}`,
  debounce: (projectId: string) => `debounce:${projectId}`,
  jobLock: (dedupKey: string) => `lock:job:${dedupKey}`,
  events: (projectId: string) => `events:${projectId}`,
  eventSeq: (projectId: string) => `events:seq:${projectId}`,
  chatSession: (projectId: string, sessionId: string) => `chat:${projectId}:${sessionId}`,
  chatTask: (taskId: string) => `chat:task:${taskId}`,
  chatAnswer: (fingerprint: string) => `chat:answer:${fingerprint}`,
  docgen: (taskId: string) => `docgen:${taskId}`,
} as const;

function build(role: string): Redis {
  const client = new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 500, 5_000),
  });
  client.on("error", (err: Error) => {
    if (!warned[role]) {
      console.warn(`[redis:${role}] ${err.message}（将自动重连；REST 链路不受影响）`);
      warned[role] = true;
    }
  });
  client.on("ready", () => {
    warned[role] = false;
    console.log(`[redis:${role}] connected`);
  });
  return client;
}

const warned: Record<string, boolean> = {};
let main: Redis | null = null;
let sub: Redis | null = null;

export function redis(): Redis {
  if (!main) {
    main = build("main");
    void main.connect().catch(() => undefined);
  }
  return main;
}

export function redisSub(): Redis {
  if (!sub) {
    sub = build("sub");
    void sub.connect().catch(() => undefined);
  }
  return sub;
}

export async function pingRedis(): Promise<boolean> {
  try {
    const pong = await redis().ping();
    return pong === "PONG";
  } catch {
    return false;
  }
}

/**
 * 等待连接就绪。
 * enableOfflineQueue=false 意味着未就绪时命令会立即失败，
 * 因此 Worker 启动阶段必须先等就绪再建消费组，否则会陷入 NOGROUP 循环。
 */
export async function waitForRedis(timeoutMs = 15_000): Promise<boolean> {
  const client = redis();
  if (client.status === "ready") return true;
  return new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      client.off("ready", onReady);
      resolve(ok);
    };
    const onReady = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    client.once("ready", onReady);
  });
}

async function readyRedis(timeoutMs = 5_000): Promise<Redis> {
  const client = redis();
  if (client.status !== "ready" && !(await waitForRedis(timeoutMs))) {
    throw new Error("Redis 连接尚未就绪");
  }
  return client;
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([main?.quit(), sub?.quit()]);
  main = null;
  sub = null;
}

// ── 事件背板（SSE） ───────────────────────────────────────────────────
/** 取该 project 单调递增的事件 id；Redis 不可用时返回 null，由 hub 用本地计数兜底 */
export async function nextEventId(projectId: string): Promise<number | null> {
  try {
    return await redis().incr(KEYS.eventSeq(projectId));
  } catch {
    return null;
  }
}

export async function publishEvent(projectId: string, payload: string): Promise<boolean> {
  try {
    await redis().publish(KEYS.events(projectId), payload);
    return true;
  } catch {
    return false;
  }
}

// ── 任务队列（Stream） ────────────────────────────────────────────────
export async function ensureConsumerGroup(): Promise<void> {
  try {
    // 从 0 开始而不是 $：消费组晚于消息创建时（首次启动/Redis 重启）仍能捞到旧消息；
    // 业务层用 queue marker 与数据库原子抢占双重防重。
    await redis().xgroup("CREATE", KEYS.stream, KEYS.group, "0", "MKSTREAM");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("BUSYGROUP")) throw err; // 已存在即视为成功
  }
}

async function enqueueOnce(
  markerKey: string,
  fields: readonly string[],
): Promise<string> {
  const client = await readyRedis();
  const marked = await client.set(markerKey, "1", "EX", 24 * 3600, "NX");
  if (marked !== "OK") return `deduplicated:${markerKey}`;
  try {
    const id = await client.xadd(KEYS.stream, "*", ...fields);
    if (!id) throw new Error("XADD 未返回消息 id");
    return id;
  } catch (error) {
    await client.del(markerKey).catch(() => undefined);
    throw error;
  }
}

export async function enqueueJob(jobId: string, projectId: string): Promise<string> {
  return enqueueOnce(KEYS.queuedJob(jobId), [
    "kind",
    "analyze",
    "jobId",
    jobId,
    "projectId",
    projectId,
  ]);
}

export async function enqueueRepositoryScan(scanId: string, projectId: string): Promise<string> {
  return enqueueOnce(KEYS.queuedRepositoryScan(scanId), [
    "kind",
    "repository_scan",
    "jobId",
    scanId,
    "projectId",
    projectId,
  ]);
}

export async function clearQueuedJob(jobId: string): Promise<void> {
  await (await readyRedis()).del(KEYS.queuedJob(jobId));
}

export async function clearQueuedRepositoryScan(scanId: string): Promise<void> {
  await (await readyRedis()).del(KEYS.queuedRepositoryScan(scanId));
}

export async function enqueueKnowledgeRun(
  runId: string,
  projectId: string,
  idempotencyKey: string = runId,
): Promise<string> {
  const client = await readyRedis();
  const id = await client.xadd(
    KEYS.knowledgeStream,
    "*",
    "schemaVersion",
    "1.0",
    "kind",
    "knowledge_generate",
    "runId",
    runId,
    "projectId",
    projectId,
    "idempotencyKey",
    idempotencyKey,
  );
  if (!id) throw new Error("Knowledge XADD 未返回消息 id");
  return id;
}

export async function enqueueSkillLabRun(
  runId: string,
  projectId: string,
  idempotencyKey: string = runId,
): Promise<string> {
  const client = await readyRedis();
  const id = await client.xadd(
    KEYS.skillLabStream,
    "*",
    "schemaVersion",
    "1.0",
    "kind",
    "skill_evaluate_optimize",
    "runId",
    runId,
    "projectId",
    projectId,
    "idempotencyKey",
    idempotencyKey,
  );
  if (!id) throw new Error("Skill Lab XADD 未返回消息 id");
  return id;
}

export interface DocgenState {
  status: "pending" | "running" | "ready_to_publish" | "succeeded" | "failed";
  projectId: string;
  nodeId: string;
  nodePath?: string;
  actorId: string;
  commitSha: string;
  repositoryId?: string;
  artifactKey?: string;
  title?: string;
  existingDingtalkNodeId?: string;
  docId?: string;
  error?: string;
  credits?: string;
}

export async function enqueueDocgen(taskId: string, projectId: string): Promise<string> {
  const client = await readyRedis();
  const id = await client.xadd(
    KEYS.stream,
    "*",
    "kind",
    "docgen",
    "jobId",
    taskId,
    "projectId",
    projectId,
  );
  if (!id) throw new Error("XADD 未返回消息 id");
  return id;
}

export interface ChatTaskState {
  status: "pending" | "running" | "succeeded" | "failed";
  stage?: string;
  note?: string;
  projectId: string;
  commitSha: string;
  repositoryId?: string;
  question: string;
  nodeId: string;
  nodeName: string;
  nodePath: string;
  groundedDraft: string;
  text?: string;
  credits?: string;
  error?: string;
}

export async function enqueueChat(taskId: string, projectId: string): Promise<string> {
  const client = await readyRedis();
  const id = await client.xadd(
    KEYS.stream,
    "*",
    "kind",
    "chat",
    "jobId",
    taskId,
    "projectId",
    projectId,
  );
  if (!id) throw new Error("XADD 未返回消息 id");
  return id;
}

export async function setChatTaskState(taskId: string, patch: Partial<ChatTaskState>): Promise<void> {
  const values: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) values.push(key, String(value));
  }
  if (values.length === 0) return;
  const client = await readyRedis();
  await client.hset(KEYS.chatTask(taskId), ...values);
  await client.expire(KEYS.chatTask(taskId), 7200);
}

export async function getChatTaskState(taskId: string): Promise<ChatTaskState | null> {
  const state = await (await readyRedis()).hgetall(KEYS.chatTask(taskId));
  if (!state || Object.keys(state).length === 0) return null;
  return state as unknown as ChatTaskState;
}

export async function getChatAnswerCache(fingerprint: string): Promise<string | null> {
  try {
    return await redis().get(KEYS.chatAnswer(fingerprint));
  } catch {
    return null;
  }
}

export async function setChatAnswerCache(
  fingerprint: string,
  text: string,
  ttlSeconds: number,
): Promise<void> {
  try {
    await redis().set(KEYS.chatAnswer(fingerprint), text, "EX", ttlSeconds);
  } catch {
    /* 回答缓存不影响主链路 */
  }
}

export async function setDocgenState(taskId: string, patch: Partial<DocgenState>): Promise<void> {
  const values: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) values.push(key, String(value));
  }
  if (values.length === 0) return;
  const client = await readyRedis();
  await client.hset(KEYS.docgen(taskId), ...values);
  await client.expire(KEYS.docgen(taskId), 7200);
}

export async function getDocgenState(taskId: string): Promise<DocgenState | null> {
  const state = await (await readyRedis()).hgetall(KEYS.docgen(taskId));
  if (!state || Object.keys(state).length === 0) return null;
  return state as unknown as DocgenState;
}

export interface StreamMessage {
  messageId: string;
  jobId: string;
  projectId: string;
  kind: "analyze" | "repository_scan" | "docgen" | "chat";
}

function parseStreamEntries(entries: Array<[string, string[]]>): StreamMessage[] {
  const messages: StreamMessage[] = [];
  for (const [messageId, fields] of entries) {
    const map = new Map<string, string>();
    for (let index = 0; index < fields.length; index += 2) {
      map.set(fields[index]!, fields[index + 1] ?? "");
    }
    const jobId = map.get("jobId");
    const projectId = map.get("projectId");
    if (!jobId || !projectId) continue;
    const kind = map.get("kind");
    messages.push({
      messageId,
      jobId,
      projectId,
      kind:
        kind === "repository_scan"
          ? "repository_scan"
          : kind === "docgen"
            ? "docgen"
            : kind === "chat"
              ? "chat"
              : "analyze",
    });
  }
  return messages;
}

export async function readJobs(consumer: string, count: number, blockMs: number): Promise<StreamMessage[]> {
  const res = (await redis().xreadgroup(
    "GROUP",
    KEYS.group,
    consumer,
    "COUNT",
    count,
    "BLOCK",
    blockMs,
    "STREAMS",
    KEYS.stream,
    ">",
  )) as Array<[string, Array<[string, string[]]>]> | null;

  if (!res) return [];
  const out: StreamMessage[] = [];
  for (const [, entries] of res) {
    out.push(...parseStreamEntries(entries));
  }
  return out;
}

export async function claimStaleJobs(
  consumer: string,
  minIdleMs: number,
  count: number,
): Promise<StreamMessage[]> {
  const result = (await redis().call(
    "XAUTOCLAIM",
    KEYS.stream,
    KEYS.group,
    consumer,
    String(minIdleMs),
    "0-0",
    "COUNT",
    String(count),
  )) as [string, Array<[string, string[]]>, string[]] | null;
  return result ? parseStreamEntries(result[1] ?? []) : [];
}

export async function ackJob(messageId: string): Promise<void> {
  await redis().xack(KEYS.stream, KEYS.group, messageId);
}

// ── 去抖 / 锁 ────────────────────────────────────────────────────────
/**
 * 去抖：窗口内同一 project 的重复触发直接吞掉（返回 false）。
 * Redis 不可用时返回 true（放行），宁可多分析一次也不丢事件。
 */
export async function shouldAcceptDebounced(projectId: string, windowSeconds: number): Promise<boolean> {
  try {
    const ok = await redis().set(KEYS.debounce(projectId), "1", "EX", windowSeconds, "NX");
    return ok === "OK";
  } catch {
    return true;
  }
}

export async function acquireLock(key: string, ttlSeconds: number): Promise<string | null> {
  const ownerToken = randomUUID();
  try {
    const ok = await redis().set(KEYS.jobLock(key), ownerToken, "EX", ttlSeconds, "NX");
    return ok === "OK" ? ownerToken : null;
  } catch {
    return `redis-unavailable:${ownerToken}`;
  }
}

export async function releaseLock(key: string, ownerToken: string): Promise<void> {
  if (ownerToken.startsWith("redis-unavailable:")) return;
  try {
    await redis().eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
      1,
      KEYS.jobLock(key),
      ownerToken,
    );
  } catch {
    /* 锁到期会自动释放 */
  }
}

// ── 会话（chat）────────────────────────────────────────────────────────
export async function appendChatTurn(
  projectId: string,
  sessionId: string,
  turn: unknown,
  ttlSeconds = 7 * 24 * 3600,
): Promise<void> {
  try {
    const key = KEYS.chatSession(projectId, sessionId);
    await redis().rpush(key, JSON.stringify(turn));
    await redis().expire(key, ttlSeconds);
  } catch {
    /* 会话留存是尽力而为，不影响回答 */
  }
}

export async function chatTurnCount(projectId: string, sessionId: string): Promise<number> {
  try {
    return await redis().llen(KEYS.chatSession(projectId, sessionId));
  } catch {
    return 0;
  }
}
