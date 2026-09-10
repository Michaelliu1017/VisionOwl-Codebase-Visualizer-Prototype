import { join } from "node:path";
import type { AppConfig } from "../config.js";
import { CoreClient } from "../core/client.js";
import type { createRuntime } from "../runtime.js";
import { KnowledgeAuditStore } from "./auditStore.js";
import { GitHubEvidenceProvider } from "./evidenceProvider.js";
import { KnowledgeRunProcessor } from "./processor.js";
import { DeterministicSemanticAnalyzer, QoderSemanticAnalyzer } from "./semantic.js";

type Runtime = Awaited<ReturnType<typeof createRuntime>>;

export function createKnowledgeProcessor(config: AppConfig, runtime: Runtime): KnowledgeRunProcessor {
  if (!config.coreBaseUrl || !config.coreServiceToken) {
    throw new Error("CORE_BASE_URL and CORE_SERVICE_TOKEN are required for Knowledge Generator integration");
  }
  const core = new CoreClient({ baseUrl: config.coreBaseUrl, serviceToken: config.coreServiceToken });
  const evidence = new GitHubEvidenceProvider({
    store: runtime.store,
    orchestrator: runtime.orchestrator,
    historyDays: config.knowledgeHistoryDays,
    maxItems: config.knowledgeMaxItems,
    maxConcurrency: config.githubMaxConcurrency,
    repositoryConcurrency: config.knowledgeRepositoryConcurrency,
  });
  const deterministic = new DeterministicSemanticAnalyzer();
  const semantic = config.knowledgeSemanticProvider === "qoder"
    ? new QoderSemanticAnalyzer({
      executable: config.qoderCliPath,
      model: config.qoderModel,
      timeoutSeconds: config.qoderTimeoutSeconds,
      maxOutputTokens: config.qoderMaxOutputTokens,
      required: config.knowledgeSemanticRequired,
      fallback: deterministic,
    })
    : deterministic;
  return new KnowledgeRunProcessor({
    core,
    evidence,
    semantic,
    audit: new KnowledgeAuditStore(join(config.dataDir, "knowledge-runs")),
  });
}
