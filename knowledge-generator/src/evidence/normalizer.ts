import { canonicalJson } from "../domain/canonicalJson.js";
import { actorId, evidenceId, fileChangeId, fileId, repositoryEvidenceId, sha256 } from "../domain/ids.js";
import { EVIDENCE_SCHEMA_VERSION, type ActorRef, type EvidenceNode } from "../domain/types.js";
import type {
  GitHubCommit,
  GitHubFileChange,
  GitHubIssueComment,
  GitHubPullRequest,
  GitHubRepository,
  GitHubReview,
  GitHubReviewComment,
  GitHubUser,
  GitHubWorkflowJob,
  GitHubWorkflowRun,
} from "../github/types.js";

interface NormalizeContext {
  externalRepositoryId: string;
  repositoryId: string;
  rawRef: string;
}

type NodeWithoutChecksum = Omit<EvidenceNode, "checksum">;

export function normalizeRepository(repository: GitHubRepository, rawRef: string): EvidenceNode[] {
  const externalRepositoryId = String(repository.id);
  const repositoryId = `github:${externalRepositoryId}`;
  const owner = normalizeActor(repository.owner, { externalRepositoryId, repositoryId, rawRef });
  return compactNodes([
    owner,
    finalizeNode({
      id: repositoryEvidenceId(externalRepositoryId),
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      provider: "github",
      repositoryId,
      kind: "repository",
      externalId: externalRepositoryId,
      state: repository.private ? "private" : "public",
      actor: owner ? actorRef(owner) : undefined,
      title: repository.full_name,
      content: repository.description ?? undefined,
      occurredAt: repository.created_at,
      updatedAt: repository.updated_at,
      sourceUrl: repository.html_url,
      rawRef,
      payload: {
        name: repository.name,
        fullName: repository.full_name,
        defaultBranch: repository.default_branch,
        language: repository.language ?? null,
        pushedAt: repository.pushed_at ?? null,
        nodeId: repository.node_id ?? null,
      },
    }),
  ]);
}

export function normalizeCommit(commit: GitHubCommit, context: NormalizeContext): EvidenceNode[] {
  const actor = normalizeActor(commit.author ?? commit.committer ?? undefined, context);
  const occurredAt =
    commit.commit.author?.date ?? commit.commit.committer?.date ?? new Date(0).toISOString();
  return compactNodes([
    actor,
    finalizeNode({
      id: evidenceId(context.externalRepositoryId, "commit", commit.sha),
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      provider: "github",
      repositoryId: context.repositoryId,
      kind: "commit",
      externalId: commit.sha,
      state: "committed",
      actor: actor ? actorRef(actor) : undefined,
      title: firstLine(commit.commit.message),
      content: commit.commit.message,
      commitSha: commit.sha,
      occurredAt,
      sourceUrl: commit.html_url,
      rawRef: context.rawRef,
      payload: {
        parents: (commit.parents ?? []).map((parent) => parent.sha),
        stats: commit.stats ?? null,
        verified: commit.commit.verification?.verified ?? null,
        verificationReason: commit.commit.verification?.reason ?? null,
        authorName: commit.commit.author?.name ?? null,
        committerName: commit.commit.committer?.name ?? null,
      },
    }),
  ]);
}

export function normalizePullRequest(pull: GitHubPullRequest, context: NormalizeContext): EvidenceNode[] {
  const actor = normalizeActor(pull.user ?? undefined, context);
  const state = pull.merged_at ? "merged" : pull.state;
  return compactNodes([
    actor,
    finalizeNode({
      id: evidenceId(context.externalRepositoryId, "change_request", pull.number),
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      provider: "github",
      repositoryId: context.repositoryId,
      kind: "change_request",
      externalId: String(pull.number),
      state,
      actor: actor ? actorRef(actor) : undefined,
      title: pull.title,
      content: pull.body ?? undefined,
      commitSha: pull.head.sha,
      occurredAt: pull.created_at,
      updatedAt: pull.updated_at,
      sourceUrl: pull.html_url,
      rawRef: context.rawRef,
      payload: {
        number: pull.number,
        draft: pull.draft ?? false,
        headRef: pull.head.ref,
        headSha: pull.head.sha,
        baseRef: pull.base.ref,
        baseSha: pull.base.sha,
        mergeCommitSha: pull.merge_commit_sha ?? null,
        mergedAt: pull.merged_at ?? null,
        closedAt: pull.closed_at ?? null,
        labels: (pull.labels ?? []).map((label) => label.name),
        requestedReviewers: (pull.requested_reviewers ?? []).map((reviewer) => reviewer.login),
      },
    }),
  ]);
}

export function normalizeReview(review: GitHubReview, context: NormalizeContext): EvidenceNode[] {
  const actor = normalizeActor(review.user ?? undefined, context);
  return compactNodes([
    actor,
    finalizeNode({
      id: evidenceId(context.externalRepositoryId, "review", review.id),
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      provider: "github",
      repositoryId: context.repositoryId,
      kind: "review",
      externalId: String(review.id),
      state: normalizeState(review.state),
      actor: actor ? actorRef(actor) : undefined,
      content: review.body ?? undefined,
      commitSha: review.commit_id ?? undefined,
      occurredAt: review.submitted_at ?? new Date(0).toISOString(),
      sourceUrl: review.html_url,
      rawRef: context.rawRef,
      payload: {
        submittedAt: review.submitted_at ?? null,
        commitId: review.commit_id ?? null,
      },
    }),
  ]);
}

export function normalizeReviewComment(comment: GitHubReviewComment, context: NormalizeContext): EvidenceNode[] {
  const actor = normalizeActor(comment.user ?? undefined, context);
  return compactNodes([
    actor,
    finalizeNode({
      id: evidenceId(context.externalRepositoryId, "comment", `review:${comment.id}`),
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      provider: "github",
      repositoryId: context.repositoryId,
      kind: "comment",
      externalId: `review:${comment.id}`,
      state: "active",
      actor: actor ? actorRef(actor) : undefined,
      content: comment.body,
      commitSha: comment.commit_id ?? comment.original_commit_id ?? undefined,
      occurredAt: comment.created_at,
      updatedAt: comment.updated_at,
      sourceUrl: comment.html_url,
      rawRef: context.rawRef,
      payload: {
        commentType: "review_comment",
        reviewId: comment.pull_request_review_id ?? null,
        path: comment.path,
        line: comment.line ?? null,
        originalLine: comment.original_line ?? null,
        side: comment.side ?? null,
        startLine: comment.start_line ?? null,
        startSide: comment.start_side ?? null,
        inReplyToId: comment.in_reply_to_id ?? null,
      },
    }),
  ]);
}

export function normalizeIssueComment(comment: GitHubIssueComment, context: NormalizeContext): EvidenceNode[] {
  const actor = normalizeActor(comment.user ?? undefined, context);
  return compactNodes([
    actor,
    finalizeNode({
      id: evidenceId(context.externalRepositoryId, "comment", `issue:${comment.id}`),
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      provider: "github",
      repositoryId: context.repositoryId,
      kind: "comment",
      externalId: `issue:${comment.id}`,
      state: "active",
      actor: actor ? actorRef(actor) : undefined,
      content: comment.body ?? undefined,
      occurredAt: comment.created_at,
      updatedAt: comment.updated_at,
      sourceUrl: comment.html_url,
      rawRef: context.rawRef,
      payload: { commentType: "issue_comment" },
    }),
  ]);
}

export function normalizeFileChange(
  change: GitHubFileChange,
  context: NormalizeContext,
  scope: "commit" | "pr",
  scopeId: string | number,
): EvidenceNode[] {
  const normalizedFileId = fileId(context.externalRepositoryId, change.filename);
  const fileSourceUrl = change.blob_url ?? change.raw_url ?? `https://github.com`;
  return [
    finalizeNode({
      id: normalizedFileId,
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      provider: "github",
      repositoryId: context.repositoryId,
      kind: "file",
      externalId: change.filename,
      state: "tracked",
      title: change.filename,
      occurredAt: new Date(0).toISOString(),
      sourceUrl: fileSourceUrl,
      rawRef: context.rawRef,
      payload: { path: change.filename },
    }),
    finalizeNode({
      id: fileChangeId(context.externalRepositoryId, scope, scopeId, change.filename),
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      provider: "github",
      repositoryId: context.repositoryId,
      kind: "file_change",
      externalId: `${scope}:${String(scopeId)}:${change.filename}`,
      state: normalizeState(change.status),
      title: change.filename,
      content: change.patch,
      commitSha: scope === "commit" ? String(scopeId) : undefined,
      occurredAt: new Date(0).toISOString(),
      sourceUrl: fileSourceUrl,
      rawRef: context.rawRef,
      payload: {
        scope,
        scopeId: String(scopeId),
        path: change.filename,
        previousPath: change.previous_filename ?? null,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.changes,
      },
    }),
  ];
}

export function normalizeWorkflowRun(run: GitHubWorkflowRun, context: NormalizeContext): EvidenceNode[] {
  const actor = normalizeActor(run.actor ?? run.triggering_actor ?? undefined, context);
  return compactNodes([
    actor,
    finalizeNode({
      id: evidenceId(context.externalRepositoryId, "ci_run", run.id),
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      provider: "github",
      repositoryId: context.repositoryId,
      kind: "ci_run",
      externalId: String(run.id),
      state: normalizeState(run.conclusion ?? run.status ?? "unknown"),
      actor: actor ? actorRef(actor) : undefined,
      title: run.display_title ?? run.name ?? `Workflow run ${run.id}`,
      commitSha: run.head_sha,
      occurredAt: run.run_started_at ?? run.created_at,
      updatedAt: run.updated_at,
      sourceUrl: run.html_url,
      rawRef: context.rawRef,
      payload: {
        workflowId: run.workflow_id,
        runNumber: run.run_number,
        runAttempt: run.run_attempt ?? 1,
        event: run.event,
        headBranch: run.head_branch ?? null,
        status: run.status ?? null,
        conclusion: run.conclusion ?? null,
        pullRequests: (run.pull_requests ?? []).map((pull) => pull.number),
      },
    }),
  ]);
}

export function normalizeWorkflowJob(job: GitHubWorkflowJob, context: NormalizeContext): EvidenceNode {
  return finalizeNode({
    id: evidenceId(context.externalRepositoryId, "ci_job", job.id),
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    provider: "github",
    repositoryId: context.repositoryId,
    kind: "ci_job",
    externalId: String(job.id),
    state: normalizeState(job.conclusion ?? job.status),
    title: job.name,
    commitSha: job.head_sha,
    occurredAt: job.started_at ?? new Date(0).toISOString(),
    updatedAt: job.completed_at ?? undefined,
    sourceUrl: job.html_url,
    rawRef: context.rawRef,
    payload: {
      runId: job.run_id,
      status: job.status,
      conclusion: job.conclusion ?? null,
      runnerName: job.runner_name ?? null,
      runnerGroupName: job.runner_group_name ?? null,
      labels: job.labels ?? [],
      steps: job.steps ?? [],
    },
  });
}

function normalizeActor(user: GitHubUser | undefined, context: NormalizeContext): EvidenceNode | undefined {
  if (!user?.id || !user.login) return undefined;
  return finalizeNode({
    id: actorId(context.externalRepositoryId, user.id),
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    provider: "github",
    repositoryId: context.repositoryId,
    kind: "actor",
    externalId: String(user.id),
    state: "active",
    title: user.login,
    occurredAt: new Date(0).toISOString(),
    sourceUrl: user.html_url ?? `https://github.com/${encodeURIComponent(user.login)}`,
    rawRef: context.rawRef,
    payload: {
      login: user.login,
      displayName: user.name ?? null,
      avatarUrl: user.avatar_url ?? null,
    },
  });
}

function actorRef(node: EvidenceNode): ActorRef {
  return {
    id: node.id,
    login: String(node.payload.login ?? node.title ?? node.externalId),
    displayName: typeof node.payload.displayName === "string" ? node.payload.displayName : undefined,
    avatarUrl: typeof node.payload.avatarUrl === "string" ? node.payload.avatarUrl : undefined,
  };
}

function finalizeNode(node: NodeWithoutChecksum): EvidenceNode {
  return {
    ...node,
    checksum: sha256(canonicalJson(node)),
  };
}

function compactNodes(nodes: Array<EvidenceNode | undefined>): EvidenceNode[] {
  return nodes.filter((node): node is EvidenceNode => Boolean(node));
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? value;
}

function normalizeState(value: string): string {
  return value.trim().toLowerCase().replaceAll(" ", "_");
}
