import type { AppConfig } from "../config.js";
import type { KnowledgeRunProcessor } from "../knowledge/processor.js";
import { KnowledgeQueueWorker } from "./knowledgeWorker.js";

export function createKnowledgeQueueWorker(
  config: AppConfig,
  processor: KnowledgeRunProcessor,
): KnowledgeQueueWorker {
  if (!config.redisUrl) throw new Error("REDIS_URL is required for the Knowledge Generator Worker");
  return new KnowledgeQueueWorker(processor, {
    redisUrl: config.redisUrl,
    stream: config.knowledgeStream,
    group: config.knowledgeConsumerGroup,
    consumer: config.knowledgeConsumerName,
    concurrency: config.knowledgeWorkerConcurrency,
    claimIdleMs: config.knowledgeClaimIdleMs,
  });
}
