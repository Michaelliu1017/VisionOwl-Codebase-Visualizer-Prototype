import { readFile } from "node:fs/promises";
import type { KnowledgeRunCommand, RepositorySnapshot } from "../codegraph/types.js";
import type { EvidenceSnapshot, RepositorySource } from "../domain/types.js";
import { validateSnapshot } from "../evidence/validator.js";
import type { SyncOrchestrator } from "../sync/orchestrator.js";
import type { EvidenceStore } from "../storage/store.js";
import type { RepositoryEvidenceInput } from "./types.js";

export interface EvidenceProviderPort {
  collect(command: KnowledgeRunCommand): Promise<RepositoryEvidenceInput[]>;
}

export interface GitHubEvidenceProviderOptions {
  store: EvidenceStore;
  orchestrator: SyncOrchestrator;
  historyDays: number;
  maxItems: number;
  maxConcurrency: number;
  repositoryConcurrency?: number;
  onRepository?: (repository: RepositorySnapshot, index: number, total: number) => Promise<void> | void;
}

export class GitHubEvidenceProvider implements EvidenceProviderPort {
  private readonly options: GitHubEvidenceProviderOptions;

  constructor(options: GitHubEvidenceProviderOptions) {
    this.options = options;
  }

  async collect(command: KnowledgeRunCommand): Promise<RepositoryEvidenceInput[]> {
    return mapLimit(
      command.repositorySnapshots,
      this.options.repositoryConcurrency ?? 2,
      async (repository, index) => {
        await this.options.onRepository?.(repository, index, command.repositorySnapshots.length);
        return {
          repository,
          snapshot: await this.collectRepository(command.projectId, repository),
        };
      },
    );
  }

  private async collectRepository(projectId: string, repository: RepositorySnapshot): Promise<EvidenceSnapshot> {
    if (!repository.commitSha) throw new Error(`${repository.repoFullName} has no frozen commit`);
    const repoUrl = `https://github.com/${repository.repoFullName}`;
    const existing = (await this.options.store.listSources()).find(
      (source) => source.projectId === projectId
        && source.repoUrl.toLowerCase() === repoUrl.toLowerCase()
        && source.branch === repository.commitSha
        && source.status !== "error",
    );
    const source = existing ?? await this.options.orchestrator.registerSource({
      projectId,
      repoUrl,
      branch: repository.commitSha,
      historySince: daysAgo(this.options.historyDays),
    });
    const run = await this.options.orchestrator.runSync(source.id, {
      historySince: daysAgo(this.options.historyDays),
      maxItems: this.options.maxItems,
      maxConcurrency: this.options.maxConcurrency,
      targetCommitSha: repository.commitSha,
    });
    if (run.status !== "succeeded" || !run.snapshotPath) {
      throw new Error(`evidence collection failed for ${repository.repoFullName}: ${run.error ?? "unknown error"}`);
    }
    const snapshot = JSON.parse(await readFile(run.snapshotPath, "utf8")) as EvidenceSnapshot;
    const validation = validateSnapshot(snapshot);
    if (!validation.valid) {
      throw new Error(`invalid evidence snapshot for ${repository.repoFullName}`);
    }
    if (snapshot.repository.commitSha !== repository.commitSha) {
      throw new Error(
        `evidence snapshot commit mismatch for ${repository.repoFullName}: ${snapshot.repository.commitSha ?? "none"}`,
      );
    }
    return snapshot;
  }
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

async function mapLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function sourceIdentity(source: RepositorySource): string {
  return `${source.projectId}:${source.repoUrl}:${source.branch ?? source.defaultBranch ?? ""}`;
}
