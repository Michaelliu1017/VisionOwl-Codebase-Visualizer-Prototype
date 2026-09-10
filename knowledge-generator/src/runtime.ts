import type { AppConfig } from "./config.js";
import { GitHubClient } from "./github/client.js";
import { createStore } from "./storage/factory.js";
import { SyncOrchestrator } from "./sync/orchestrator.js";

export async function createRuntime(config: AppConfig) {
  const store = createStore(config);
  await store.initialize();
  const github = new GitHubClient({
    token: config.githubToken,
    baseUrl: config.githubApiBaseUrl,
    apiVersion: config.githubApiVersion,
    onRateLimitWait: (waitMs, response) => {
      process.stderr.write(`GitHub rate limit response ${response.status}; waiting ${waitMs}ms\n`);
    },
  });
  const orchestrator = new SyncOrchestrator({
    store,
    github,
    dataDir: config.dataDir,
    defaultHistoryDays: config.githubHistoryDays,
    defaultMaxItems: config.githubMaxItems,
    defaultMaxConcurrency: config.githubMaxConcurrency,
  });
  return { store, github, orchestrator };
}
