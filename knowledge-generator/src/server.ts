import { createApp } from "./api/app.js";
import { loadConfig } from "./config.js";
import { createKnowledgeProcessor } from "./knowledge/runtime.js";
import { createKnowledgeQueueWorker } from "./queue/runtime.js";
import { createRuntime } from "./runtime.js";

const config = loadConfig();
const runtime = await createRuntime(config);
const app = createApp({ store: runtime.store, orchestrator: runtime.orchestrator });
const worker = config.knowledgeWorkerEnabled
  ? createKnowledgeQueueWorker(config, createKnowledgeProcessor(config, runtime))
  : undefined;
const workerLoop = worker?.start().catch((error: unknown) => {
  app.log.error({ error }, "Knowledge Generator Worker stopped unexpectedly");
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await worker?.stop();
  await workerLoop?.catch(() => undefined);
  await app.close();
  await runtime.store.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.host, port: config.port });
