import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  actorId,
  edgeId,
  evidenceId,
  fileChangeId,
  fileId,
  repositoryEvidenceId,
} from "../domain/ids.js";
import { resolveGitHubSource } from "../domain/sourceResolver.js";
import type {
  EvidenceNode,
  RawRecord,
  RepositorySource,
  SyncRequestOptions,
  SyncRun,
} from "../domain/types.js";
import {
  normalizeCommit,
  normalizeFileChange,
  normalizeIssueComment,
  normalizePullRequest,
  normalizeRepository,
  normalizeReview,
  normalizeReviewComment,
  normalizeWorkflowJob,
  normalizeWorkflowRun,
} from "../evidence/normalizer.js";
import { type LinkCandidate, resolveLinks } from "../evidence/linker.js";
import { createRawRecord } from "../evidence/raw.js";
import { buildSnapshot, writeSnapshot } from "../evidence/snapshot.js";
import { validateEvidenceGraph } from "../evidence/validator.js";
import type {
  GitHubClientPort,
  GitHubCommit,
  GitHubFetched,
  GitHubFileChange,
  GitHubIssueComment,
  GitHubPullRequest,
  GitHubReview,
  GitHubReviewComment,
  GitHubWorkflowJob,
  GitHubWorkflowRun,
} from "../github/types.js";
import type { EvidenceStore } from "../storage/store.js";

export interface RegisterSourceInput {
  projectId: string;
  repoUrl: string;
  branch?: string;
  historySince?: string;
}

export interface SyncOrchestratorOptions {
  store: EvidenceStore;
  github: GitHubClientPort;
  dataDir: string;
  defaultHistoryDays?: number;
  defaultMaxItems?: number;
  defaultMaxConcurrency?: number;
  now?: () => Date;
}

export class SyncOrchestrator {
  private readonly store: EvidenceStore;
  private readonly github: GitHubClientPort;
  private readonly dataDir: string;
  private readonly defaultHistoryDays: number;
  private readonly defaultMaxItems: number;
  private readonly defaultMaxConcurrency: number;
  private readonly now: () => Date;
  private readonly activeSources = new Set<string>();

  constructor(options: SyncOrchestratorOptions) {
    this.store = options.store;
    this.github = options.github;
    this.dataDir = options.dataDir;
    this.defaultHistoryDays = options.defaultHistoryDays ?? 180;
    this.defaultMaxItems = options.defaultMaxItems ?? 500;
    this.defaultMaxConcurrency = options.defaultMaxConcurrency ?? 3;
    this.now = options.now ?? (() => new Date());
  }

  async registerSource(input: RegisterSourceInput): Promise<RepositorySource> {
    const resolved = resolveGitHubSource(input.repoUrl);
    const now = this.now().toISOString();
    const source: RepositorySource = {
      id: randomUUID(),
      projectId: input.projectId,
      provider: "github",
      repoUrl: resolved.canonicalUrl,
      owner: resolved.owner,
      repo: resolved.repo,
      branch: input.branch,
      historySince: input.historySince ?? daysAgo(this.now(), this.defaultHistoryDays),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    await this.store.createSource(source);

    try {
      const fetched = await this.github.getRepository(source.owner, source.repo);
      if (fetched.data.private) throw new Error("stage 1 only supports public GitHub repositories");
      const externalRepositoryId = String(fetched.data.id);
      const repositoryId = `github:${externalRepositoryId}`;
      const raw = createRawRecord(
        externalRepositoryId,
        repositoryId,
        "repository",
        externalRepositoryId,
        fetched,
        this.now().toISOString(),
      );
      await this.store.upsertRawRecords([raw]);
      await this.store.upsertNodes(normalizeRepository(fetched.data, raw.id));

      const ready: RepositorySource = {
        ...source,
        externalRepositoryId,
        repositoryId,
        defaultBranch: fetched.data.default_branch,
        branch: source.branch ?? fetched.data.default_branch,
        status: "ready",
        updatedAt: this.now().toISOString(),
      };
      await this.store.updateSource(ready);
      return ready;
    } catch (error) {
      await this.store.updateSource({
        ...source,
        status: "error",
        error: errorMessage(error),
        updatedAt: this.now().toISOString(),
      });
      throw error;
    }
  }

  async startSync(sourceId: string, options: SyncRequestOptions = {}): Promise<SyncRun> {
    const run = await this.createSyncRun(sourceId);
    queueMicrotask(() => {
      void this.executeSync(run.id, options);
    });
    return run;
  }

  async runSync(sourceId: string, options: SyncRequestOptions = {}): Promise<SyncRun> {
    const run = await this.createSyncRun(sourceId);
    return this.executeSync(run.id, options);
  }

  async executeSync(runId: string, options: SyncRequestOptions = {}): Promise<SyncRun> {
    const run = await this.requireRun(runId);
    const source = await this.requireSource(run.sourceId);
    if (this.activeSources.has(source.id)) {
      const failed = {
        ...run,
        status: "failed" as const,
        phase: "rejected",
        error: "another sync is already running for this source",
        finishedAt: this.now().toISOString(),
        updatedAt: this.now().toISOString(),
      };
      await this.store.updateSyncRun(failed);
      return failed;
    }

    this.activeSources.add(source.id);
    const startedAt = this.now().toISOString();
    let running: SyncRun = { ...run, status: "running", phase: "repository", startedAt, updatedAt: startedAt };
    await this.store.updateSyncRun(running);
    await this.store.updateSource({ ...source, status: "syncing", updatedAt: startedAt, error: undefined });
    const requestCountBefore = this.github.requestCount;

    try {
      const result = await this.collect(source, running, options);
      const refreshedSource = await this.requireSource(source.id);
      const snapshot = await buildSnapshot(this.store, refreshedSource);
      const validation = validateEvidenceGraph(snapshot.nodes, snapshot.edges, snapshot.pendingLinks);
      if (!validation.valid) {
        throw new Error(
          `evidence validation failed: ${validation.issues
            .filter((issue) => issue.severity === "error")
            .map((issue) => `${issue.code}: ${issue.message}`)
            .join("; ")}`,
        );
      }
      const snapshotPath = await writeSnapshot(snapshot, this.dataDir);
      const finishedAt = this.now().toISOString();
      running = {
        ...running,
        status: "succeeded",
        phase: "completed",
        finishedAt,
        updatedAt: finishedAt,
        snapshotPath,
        counts: {
          rawRecords: result.rawRecords,
          nodes: snapshot.nodes.length,
          edges: snapshot.edges.length,
          pendingLinks: snapshot.pendingLinks.length,
          apiRequests: this.github.requestCount - requestCountBefore,
        },
        warnings: validation.issues.filter((issue) => issue.severity === "warning").map((issue) => issue.message),
      };
      await this.store.updateSyncRun(running);
      await this.store.updateSource({
        ...refreshedSource,
        status: "ready",
        lastSyncedAt: finishedAt,
        updatedAt: finishedAt,
        error: undefined,
      });
      return running;
    } catch (error) {
      const failedAt = this.now().toISOString();
      const failed: SyncRun = {
        ...running,
        status: "failed",
        phase: "failed",
        finishedAt: failedAt,
        updatedAt: failedAt,
        error: errorMessage(error),
        counts: {
          ...running.counts,
          apiRequests: this.github.requestCount - requestCountBefore,
        },
      };
      await this.store.updateSyncRun(failed);
      await this.store.updateSource({
        ...source,
        status: "error",
        error: failed.error,
        updatedAt: failedAt,
      });
      return failed;
    } finally {
      this.activeSources.delete(source.id);
    }
  }

  private async createSyncRun(sourceId: string): Promise<SyncRun> {
    const source = await this.requireSource(sourceId);
    if (!source.externalRepositoryId || !source.repositoryId || !source.defaultBranch) {
      throw new Error(`source ${sourceId} is not ready`);
    }
    const now = this.now().toISOString();
    return this.store.createSyncRun({
      id: randomUUID(),
      sourceId,
      mode: source.lastSyncedAt ? "incremental" : "initial",
      status: "queued",
      phase: "queued",
      createdAt: now,
      updatedAt: now,
      counts: { rawRecords: 0, nodes: 0, edges: 0, pendingLinks: 0, apiRequests: 0 },
      warnings: [],
    });
  }

  private async collect(
    source: RepositorySource,
    run: SyncRun,
    options: SyncRequestOptions,
  ): Promise<{ rawRecords: number }> {
    const externalRepositoryId = source.externalRepositoryId!;
    const repositoryId = source.repositoryId!;
    const branch = source.branch ?? source.defaultBranch!;
    const since = options.historySince ?? (run.mode === "incremental" ? source.lastSyncedAt : source.historySince);
    const maxItems = options.maxItems ?? this.defaultMaxItems;
    const maxConcurrency = options.maxConcurrency ?? this.defaultMaxConcurrency;
    const accumulator = new EvidenceAccumulator(externalRepositoryId, repositoryId);

    const repository = await this.github.getRepository(source.owner, source.repo);
    const repositoryRaw = accumulator.addRaw("repository", externalRepositoryId, repository);
    accumulator.addNodes(normalizeRepository(repository.data, repositoryRaw.id));

    await this.setRunPhase(run, "commits");
    const commitSummaries = await collectLimited(this.github.listCommits(source.owner, source.repo, branch, since), maxItems);
    if (options.targetCommitSha && !commitSummaries.some((item) => item.data.sha === options.targetCommitSha)) {
      commitSummaries.unshift(await this.github.getCommit(source.owner, source.repo, options.targetCommitSha));
    }
    const commitTasks = new Map<string, Promise<void>>();
    const collectCommitDetail = (summary: GitHubFetched<GitHubCommit>): Promise<void> => {
      const existing = commitTasks.get(summary.data.sha);
      if (existing) return existing;
      const task = this.collectCommit(source, accumulator, summary).catch((error) => {
        accumulator.warnings.push(`commit ${summary.data.sha} detail failed: ${errorMessage(error)}`);
        this.collectCommitSummary(accumulator, summary);
      });
      commitTasks.set(summary.data.sha, task);
      return task;
    };
    await mapLimit(commitSummaries, maxConcurrency, collectCommitDetail);
    const latestCommitSha = options.targetCommitSha ?? commitSummaries[0]?.data.sha;

    await this.setRunPhase(run, "pull_requests");
    const pullRequests = (await collectLimited(this.github.listPullRequests(source.owner, source.repo), maxItems)).filter(
      (item) => !since || item.data.updated_at >= since,
    );
    for (const pull of pullRequests) {
      const raw = accumulator.addRaw("pull_request", pull.data.number, pull);
      accumulator.addNodes(normalizePullRequest(pull.data, accumulator.context(raw.id)));
      accumulator.linkRepositoryTo(evidenceId(externalRepositoryId, "change_request", pull.data.number), raw.id);
    }
    await mapLimit(pullRequests, maxConcurrency, async (pull) => {
      await this.collectPullRequest(source, accumulator, pull.data, maxItems, collectCommitDetail);
    });

    await this.setRunPhase(run, "ci_runs");
    const workflowRuns = (await collectLimited(this.github.listWorkflowRuns(source.owner, source.repo), maxItems)).filter(
      (item) => !since || item.data.updated_at >= since,
    );
    for (const workflowRun of workflowRuns) {
      const raw = accumulator.addRaw("workflow_run", workflowRun.data.id, workflowRun);
      accumulator.addNodes(normalizeWorkflowRun(workflowRun.data, accumulator.context(raw.id)));
      const runNodeId = evidenceId(externalRepositoryId, "ci_run", workflowRun.data.id);
      accumulator.linkRepositoryTo(runNodeId, raw.id);
      accumulator.addLink(
        runNodeId,
        evidenceId(externalRepositoryId, "commit", workflowRun.data.head_sha),
        "CI_VALIDATES_COMMIT",
        "GitHub workflow_run.head_sha",
        raw.id,
      );
      for (const pull of workflowRun.data.pull_requests ?? []) {
        accumulator.addLink(
          runNodeId,
          evidenceId(externalRepositoryId, "change_request", pull.number),
          "CI_VALIDATES_CHANGE_REQUEST",
          "GitHub workflow_run.pull_requests[].number",
          raw.id,
        );
      }
    }
    await mapLimit(workflowRuns, maxConcurrency, async (workflowRun) => {
      await this.collectWorkflowJobs(source, accumulator, workflowRun.data, maxItems);
    });

    await Promise.all(commitTasks.values());

    await this.setRunPhase(run, "persisting");
    await this.store.upsertRawRecords([...accumulator.rawRecords.values()]);
    await this.store.upsertNodes([...accumulator.nodes.values()]);
    const allNodes = await this.store.listNodes(repositoryId);
    const links = resolveLinks(allNodes, [...accumulator.linkCandidates.values()], this.now().toISOString());
    await this.store.upsertEdges(links.edges);
    await this.store.replacePendingLinks(repositoryId, links.pendingLinks);
    await this.store.putCheckpoint({
      sourceId: source.id,
      resourceType: "repository_sync",
      lastSuccessfulAt: this.now().toISOString(),
      metadata: {
        branch,
        since: since ?? null,
        lastDefaultBranchSha: latestCommitSha ?? null,
        pullsProcessed: pullRequests.length,
        workflowRunsProcessed: workflowRuns.length,
      },
    });
    await this.store.updateSource({
      ...source,
      defaultBranch: repository.data.default_branch,
      branch,
      lastDefaultBranchSha: latestCommitSha ?? source.lastDefaultBranchSha,
      updatedAt: this.now().toISOString(),
    });

    run.warnings.push(...accumulator.warnings);
    return { rawRecords: accumulator.rawRecords.size };
  }

  private async collectCommit(
    source: RepositorySource,
    accumulator: EvidenceAccumulator,
    summary: GitHubFetched<GitHubCommit>,
  ): Promise<void> {
    const detail = await this.github.getCommit(source.owner, source.repo, summary.data.sha);
    const raw = accumulator.addRaw("commit", detail.data.sha, detail);
    accumulator.addNodes(normalizeCommit(detail.data, accumulator.context(raw.id)));
    const commitNodeId = evidenceId(accumulator.externalRepositoryId, "commit", detail.data.sha);
    accumulator.linkRepositoryTo(commitNodeId, raw.id);
    for (const parent of detail.data.parents ?? []) {
      accumulator.addLink(
        evidenceId(accumulator.externalRepositoryId, "commit", parent.sha),
        commitNodeId,
        "COMMIT_PARENT_OF",
        "GitHub commit.parents[].sha",
        raw.id,
      );
    }
    for (const change of detail.data.files ?? []) {
      this.addFileChange(accumulator, change, "commit", detail.data.sha, raw.id);
    }
  }

  private collectCommitSummary(accumulator: EvidenceAccumulator, summary: GitHubFetched<GitHubCommit>): void {
    const raw = accumulator.addRaw("commit", summary.data.sha, summary);
    accumulator.addNodes(normalizeCommit(summary.data, accumulator.context(raw.id)));
    accumulator.linkRepositoryTo(evidenceId(accumulator.externalRepositoryId, "commit", summary.data.sha), raw.id);
  }

  private async collectPullRequest(
    source: RepositorySource,
    accumulator: EvidenceAccumulator,
    pull: GitHubPullRequest,
    maxItems: number,
    collectCommitDetail: (summary: GitHubFetched<GitHubCommit>) => Promise<void>,
  ): Promise<void> {
    const pullNodeId = evidenceId(accumulator.externalRepositoryId, "change_request", pull.number);
    const [commits, files, reviews, reviewComments, issueComments] = await Promise.all([
      collectLimited(this.github.listPullCommits(source.owner, source.repo, pull.number), maxItems),
      collectLimited(this.github.listPullFiles(source.owner, source.repo, pull.number), maxItems),
      collectLimited(this.github.listReviews(source.owner, source.repo, pull.number), maxItems),
      collectLimited(this.github.listReviewComments(source.owner, source.repo, pull.number), maxItems),
      collectLimited(this.github.listIssueComments(source.owner, source.repo, pull.number), maxItems),
    ]);

    for (const commit of commits) {
      await collectCommitDetail(commit);
      accumulator.addLink(
        pullNodeId,
        evidenceId(accumulator.externalRepositoryId, "commit", commit.data.sha),
        "PR_CONTAINS_COMMIT",
        "GitHub pull request commits endpoint",
        accumulator.rawRefFor("pull_request", pull.number),
      );
    }

    for (const file of files) {
      const raw = accumulator.addRaw("pull_file", `${pull.number}:${file.data.filename}`, file);
      this.addFileChange(accumulator, file.data, "pr", pull.number, raw.id);
    }

    for (const review of reviews) {
      const raw = accumulator.addRaw("review", review.data.id, review);
      accumulator.addNodes(normalizeReview(review.data, accumulator.context(raw.id)));
      accumulator.addLink(
        pullNodeId,
        evidenceId(accumulator.externalRepositoryId, "review", review.data.id),
        "PR_HAS_REVIEW",
        "GitHub pull request reviews endpoint",
        raw.id,
      );
    }

    for (const comment of reviewComments) {
      const raw = accumulator.addRaw("review_comment", comment.data.id, comment);
      accumulator.addNodes(normalizeReviewComment(comment.data, accumulator.context(raw.id)));
      const commentNodeId = evidenceId(accumulator.externalRepositoryId, "comment", `review:${comment.data.id}`);
      if (comment.data.pull_request_review_id) {
        accumulator.addLink(
          evidenceId(accumulator.externalRepositoryId, "review", comment.data.pull_request_review_id),
          commentNodeId,
          "REVIEW_HAS_COMMENT",
          "GitHub review comment.pull_request_review_id",
          raw.id,
        );
      } else {
        accumulator.addLink(
          pullNodeId,
          commentNodeId,
          "PR_HAS_COMMENT",
          "GitHub pull request review comment endpoint",
          raw.id,
        );
      }
      if (comment.data.in_reply_to_id) {
        accumulator.addLink(
          commentNodeId,
          evidenceId(accumulator.externalRepositoryId, "comment", `review:${comment.data.in_reply_to_id}`),
          "COMMENT_REPLIES_TO",
          "GitHub review comment.in_reply_to_id",
          raw.id,
        );
      }
      accumulator.addLink(
        commentNodeId,
        fileId(accumulator.externalRepositoryId, comment.data.path),
        "COMMENT_TARGETS_FILE",
        "GitHub review comment.path",
        raw.id,
      );
    }

    for (const comment of issueComments) {
      const raw = accumulator.addRaw("issue_comment", comment.data.id, comment);
      accumulator.addNodes(normalizeIssueComment(comment.data, accumulator.context(raw.id)));
      accumulator.addLink(
        pullNodeId,
        evidenceId(accumulator.externalRepositoryId, "comment", `issue:${comment.data.id}`),
        "PR_HAS_COMMENT",
        "GitHub issue comment attached to pull request number",
        raw.id,
      );
    }

    if (pull.merge_commit_sha) {
      accumulator.addLink(
        pullNodeId,
        evidenceId(accumulator.externalRepositoryId, "commit", pull.merge_commit_sha),
        "PR_MERGED_AS_COMMIT",
        "GitHub pull_request.merge_commit_sha",
        accumulator.rawRefFor("pull_request", pull.number),
      );
    }
  }

  private async collectWorkflowJobs(
    source: RepositorySource,
    accumulator: EvidenceAccumulator,
    run: GitHubWorkflowRun,
    maxItems: number,
  ): Promise<void> {
    const jobs = await collectLimited(this.github.listWorkflowJobs(source.owner, source.repo, run.id), maxItems);
    for (const job of jobs) {
      const raw = accumulator.addRaw("workflow_job", job.data.id, job);
      accumulator.addNodes([normalizeWorkflowJob(job.data, accumulator.context(raw.id))]);
      accumulator.addLink(
        evidenceId(accumulator.externalRepositoryId, "ci_run", run.id),
        evidenceId(accumulator.externalRepositoryId, "ci_job", job.data.id),
        "CI_CONTAINS_JOB",
        "GitHub workflow job.run_id",
        raw.id,
      );
    }
  }

  private addFileChange(
    accumulator: EvidenceAccumulator,
    change: GitHubFileChange,
    scope: "commit" | "pr",
    scopeId: string | number,
    rawRef: string,
  ): void {
    accumulator.addNodes(normalizeFileChange(change, accumulator.context(rawRef), scope, scopeId));
    const changeNodeId = fileChangeId(accumulator.externalRepositoryId, scope, scopeId, change.filename);
    const targetFileId = fileId(accumulator.externalRepositoryId, change.filename);
    accumulator.addLink(
      scope === "commit"
        ? evidenceId(accumulator.externalRepositoryId, "commit", scopeId)
        : evidenceId(accumulator.externalRepositoryId, "change_request", scopeId),
      changeNodeId,
      scope === "commit" ? "COMMIT_CHANGES_FILE" : "PR_CHANGES_FILE",
      scope === "commit" ? "GitHub commit.files[]" : "GitHub pull request files endpoint",
      rawRef,
    );
    accumulator.addLink(
      changeNodeId,
      targetFileId,
      "FILE_CHANGE_TARGETS_FILE",
      "GitHub file change filename",
      rawRef,
    );
  }

  private async setRunPhase(run: SyncRun, phase: string): Promise<void> {
    run.phase = phase;
    run.updatedAt = this.now().toISOString();
    await this.store.updateSyncRun(run);
  }

  private async requireSource(sourceId: string): Promise<RepositorySource> {
    const source = await this.store.getSource(sourceId);
    if (!source) throw new Error(`source ${sourceId} not found`);
    return source;
  }

  private async requireRun(runId: string): Promise<SyncRun> {
    const run = await this.store.getSyncRun(runId);
    if (!run) throw new Error(`sync run ${runId} not found`);
    return run;
  }
}

class EvidenceAccumulator {
  readonly rawRecords = new Map<string, RawRecord>();
  readonly nodes = new Map<string, EvidenceNode>();
  readonly linkCandidates = new Map<string, LinkCandidate>();
  readonly warnings: string[] = [];

  constructor(
    readonly externalRepositoryId: string,
    readonly repositoryId: string,
  ) {}

  context(rawRef: string): { externalRepositoryId: string; repositoryId: string; rawRef: string } {
    return { externalRepositoryId: this.externalRepositoryId, repositoryId: this.repositoryId, rawRef };
  }

  addRaw<T>(resourceType: string, externalId: string | number, fetched: GitHubFetched<T>): RawRecord {
    const raw = createRawRecord(
      this.externalRepositoryId,
      this.repositoryId,
      resourceType,
      externalId,
      fetched as GitHubFetched<unknown>,
    );
    this.rawRecords.set(raw.id, raw);
    return raw;
  }

  addNodes(nodes: EvidenceNode[]): void {
    for (const node of nodes) {
      this.nodes.set(node.id, node);
      if (node.kind !== "repository") this.linkRepositoryTo(node.id, node.rawRef);
      if (node.actor && node.actor.id !== node.id) {
        this.addLink(node.actor.id, node.id, "ACTOR_AUTHORED", "GitHub object user/actor field", node.rawRef);
      }
    }
  }

  linkRepositoryTo(nodeId: string, rawRef?: string): void {
    this.addLink(
      repositoryEvidenceId(this.externalRepositoryId),
      nodeId,
      "REPOSITORY_HAS_EVIDENCE",
      "normalized object belongs to GitHub repository ID",
      rawRef,
    );
  }

  addLink(
    fromId: string,
    toId: string,
    relationType: LinkCandidate["relationType"],
    basis: string,
    rawRef?: string,
  ): void {
    const id = edgeId(fromId, relationType, toId);
    this.linkCandidates.set(id, {
      repositoryId: this.repositoryId,
      fromId,
      toId,
      relationType,
      basis,
      rawRef,
    });
  }

  rawRefFor(resourceType: string, externalId: string | number): string | undefined {
    return [...this.rawRecords.values()].find(
      (record) => record.resourceType === resourceType && record.externalId === String(externalId),
    )?.id;
  }
}

async function collectLimited<T>(iterable: AsyncIterable<T>, maxItems: number): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
    if (items.length >= maxItems) break;
  }
  return items;
}

async function mapLimit<T>(items: T[], concurrency: number, operation: (item: T) => Promise<void>): Promise<void> {
  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length || 1));
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: safeConcurrency }, async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex];
        nextIndex += 1;
        if (item !== undefined) await operation(item);
      }
    }),
  );
}

function daysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1_000).toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
