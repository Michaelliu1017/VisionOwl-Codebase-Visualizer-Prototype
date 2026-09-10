import { loadConfig } from "./config.js";
import { createKnowledgeProcessor } from "./knowledge/runtime.js";
import { createKnowledgeQueueWorker } from "./queue/runtime.js";
import { createRuntime } from "./runtime.js";

const config = loadConfig({ ...process.env, KNOWLEDGE_WORKER_ENABLED: "true" });
const runtime = await createRuntime(config);
const processor = createKnowledgeProcessor(config, runtime);
const worker = createKnowledgeQueueWorker(config, processor);

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`[knowledge-worker] received ${signal}, shutting down`);
  await worker.stop();
  await runtime.store.close();
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await worker.start();
