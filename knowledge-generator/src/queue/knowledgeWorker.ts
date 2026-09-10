import { Redis } from "ioredis";
import type { KnowledgeRunProcessor } from "../knowledge/processor.js";

export interface KnowledgeQueueWorkerOptions {
  redisUrl: string;
  stream: string;
  group: string;
  consumer: string;
  concurrency: number;
  claimIdleMs: number;
  blockMs?: number;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

interface QueueMessage {
  id: string;
  values: Record<string, string>;
}

/** Reliable Redis Stream consumer for knowledge_generate commands. */
export class KnowledgeQueueWorker {
  private readonly client: Redis;
  private readonly log: Pick<Console, "info" | "warn" | "error">;
  private stopping = false;
  private running?: Promise<void>;

  constructor(
    private readonly processor: KnowledgeRunProcessor,
    private readonly options: KnowledgeQueueWorkerOptions,
  ) {
    this.client = new Redis(options.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
      retryStrategy: (attempt: number) => Math.min(attempt * 500, 5_000),
    });
    this.log = options.logger ?? console;
    this.client.on("error", (error: Error) => this.log.warn(`[knowledge-worker:redis] ${error.message}`));
  }

  start(): Promise<void> {
    if (!this.running) this.running = this.run();
    return this.running;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.client.status !== "end") this.client.disconnect(false);
    await this.running?.catch(() => undefined);
  }

  private async run(): Promise<void> {
    if (this.client.status === "wait") await this.client.connect();
    await this.ensureGroup();
    this.log.info(
      `[knowledge-worker] consuming ${this.options.stream} as ${this.options.group}/${this.options.consumer}`,
    );
    let claimCursor = "0-0";
    while (!this.stopping) {
      try {
        const claimed = await this.claim(claimCursor);
        claimCursor = claimed.cursor;
        if (claimed.messages.length > 0) {
          await this.processBatch(claimed.messages);
          continue;
        }
        const messages = await this.readNew();
        if (messages.length > 0) await this.processBatch(messages);
      } catch (error) {
        if (this.stopping) break;
        this.log.error(`[knowledge-worker] ${errorMessage(error)}`);
        await delay(1_000);
        if (this.client.status === "end") throw error;
      }
    }
  }

  private async ensureGroup(): Promise<void> {
    try {
      await this.client.xgroup("CREATE", this.options.stream, this.options.group, "0", "MKSTREAM");
    } catch (error) {
      if (!errorMessage(error).includes("BUSYGROUP")) throw error;
    }
  }

  private async readNew(): Promise<QueueMessage[]> {
    const response = await this.client.xreadgroup(
      "GROUP",
      this.options.group,
      this.options.consumer,
      "COUNT",
      this.options.concurrency,
      "BLOCK",
      this.options.blockMs ?? 5_000,
      "STREAMS",
      this.options.stream,
      ">",
    ) as unknown;
    return parseReadResponse(response);
  }

  private async claim(cursor: string): Promise<{ cursor: string; messages: QueueMessage[] }> {
    const response = await this.client.xautoclaim(
      this.options.stream,
      this.options.group,
      this.options.consumer,
      this.options.claimIdleMs,
      cursor,
      "COUNT",
      this.options.concurrency,
    ) as unknown;
    if (!Array.isArray(response)) return { cursor: "0-0", messages: [] };
    return {
      cursor: typeof response[0] === "string" ? response[0] : "0-0",
      messages: parseEntries(response[1]),
    };
  }

  private async processBatch(messages: QueueMessage[]): Promise<void> {
    await Promise.all(messages.slice(0, this.options.concurrency).map((message) => this.processMessage(message)));
  }

  private async processMessage(message: QueueMessage): Promise<void> {
    const { kind, schemaVersion, runId, projectId } = message.values;
    if (kind !== "knowledge_generate" || schemaVersion !== "1.0" || !runId || !projectId) {
      this.log.error(`[knowledge-worker] discarding invalid message ${message.id}`);
      await this.client.xack(this.options.stream, this.options.group, message.id);
      return;
    }
    this.log.info(`[knowledge-worker] start run=${runId} project=${projectId}`);
    try {
      const result = await this.processor.process(runId);
      await this.client.xack(this.options.stream, this.options.group, message.id);
      this.log.info(`[knowledge-worker] ${result.status} run=${runId}${result.error ? ` error=${result.error}` : ""}`);
    } catch (error) {
      // Keep the entry pending when the Core failure callback was unreachable.
      // XAUTOCLAIM will retry it after claimIdleMs, preserving at-least-once delivery.
      this.log.error(`[knowledge-worker] retryable failure run=${runId}: ${errorMessage(error)}`);
    }
  }
}

function parseReadResponse(value: unknown): QueueMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((stream) => Array.isArray(stream) ? parseEntries(stream[1]) : []);
}

function parseEntries(value: unknown): QueueMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || !Array.isArray(entry[1])) return [];
    const values: Record<string, string> = {};
    for (let index = 0; index < entry[1].length; index += 2) {
      const key = entry[1][index];
      const item = entry[1][index + 1];
      if (typeof key === "string" && typeof item === "string") values[key] = item;
    }
    return [{ id: entry[0], values }];
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
