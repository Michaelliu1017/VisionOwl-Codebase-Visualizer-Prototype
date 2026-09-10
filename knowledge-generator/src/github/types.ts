export interface GitHubUser {
  id: number;
  login: string;
  name?: string | null;
  avatar_url?: string;
  html_url?: string;
}

export interface GitHubRepository {
  id: number;
  node_id?: string;
  name: string;
  full_name: string;
  description?: string | null;
  html_url: string;
  default_branch: string;
  private: boolean;
  language?: string | null;
  created_at: string;
  updated_at: string;
  pushed_at?: string;
  owner: GitHubUser;
}

export interface GitHubCommitPerson {
  name?: string | null;
  email?: string | null;
  date?: string | null;
}

export interface GitHubCommit {
  sha: string;
  html_url: string;
  author?: GitHubUser | null;
  committer?: GitHubUser | null;
  commit: {
    message: string;
    author?: GitHubCommitPerson | null;
    committer?: GitHubCommitPerson | null;
    verification?: {
      verified: boolean;
      reason?: string;
      verified_at?: string | null;
    };
  };
  parents?: Array<{ sha: string; html_url?: string }>;
  stats?: { additions?: number; deletions?: number; total?: number };
  files?: GitHubFileChange[];
}

export interface GitHubPullRequest {
  id: number;
  number: number;
  html_url: string;
  state: "open" | "closed";
  title: string;
  body?: string | null;
  user?: GitHubUser | null;
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  closed_at?: string | null;
  created_at: string;
  updated_at: string;
  merge_commit_sha?: string | null;
  head: { ref: string; sha: string; repo?: { id: number; full_name: string } | null };
  base: { ref: string; sha: string; repo?: { id: number; full_name: string } | null };
  labels?: Array<{ id: number; name: string; color?: string }>;
  requested_reviewers?: GitHubUser[];
}

export interface GitHubReview {
  id: number;
  html_url: string;
  user?: GitHubUser | null;
  body?: string | null;
  state: string;
  commit_id?: string | null;
  submitted_at?: string | null;
  pull_request_url?: string;
}

export interface GitHubReviewComment {
  id: number;
  html_url: string;
  user?: GitHubUser | null;
  body: string;
  created_at: string;
  updated_at: string;
  pull_request_review_id?: number | null;
  commit_id?: string | null;
  original_commit_id?: string | null;
  path: string;
  line?: number | null;
  original_line?: number | null;
  side?: string | null;
  start_line?: number | null;
  start_side?: string | null;
  in_reply_to_id?: number | null;
}

export interface GitHubIssueComment {
  id: number;
  html_url: string;
  user?: GitHubUser | null;
  body?: string | null;
  created_at: string;
  updated_at: string;
}

export interface GitHubFileChange {
  sha?: string;
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  blob_url?: string;
  raw_url?: string;
  patch?: string;
  previous_filename?: string;
}

export interface GitHubWorkflowRun {
  id: number;
  name?: string | null;
  display_title?: string;
  html_url: string;
  event: string;
  status?: string | null;
  conclusion?: string | null;
  workflow_id: number;
  run_number: number;
  run_attempt?: number;
  head_branch?: string | null;
  head_sha: string;
  created_at: string;
  updated_at: string;
  run_started_at?: string;
  actor?: GitHubUser | null;
  triggering_actor?: GitHubUser | null;
  pull_requests?: Array<{ id: number; number: number; url?: string }>;
}

export interface GitHubWorkflowJob {
  id: number;
  run_id: number;
  html_url: string;
  name: string;
  status: string;
  conclusion?: string | null;
  head_sha?: string;
  started_at?: string | null;
  completed_at?: string | null;
  runner_name?: string | null;
  runner_group_name?: string | null;
  labels?: string[];
  steps?: Array<{
    name: string;
    status: string;
    conclusion?: string | null;
    number: number;
    started_at?: string | null;
    completed_at?: string | null;
  }>;
}

export interface GitHubFetched<T> {
  data: T;
  requestUrl: string;
  etag?: string;
}

export interface GitHubClientPort {
  readonly requestCount: number;
  getRepository(owner: string, repo: string): Promise<GitHubFetched<GitHubRepository>>;
  listCommits(owner: string, repo: string, branch: string, since?: string): AsyncIterable<GitHubFetched<GitHubCommit>>;
  getCommit(owner: string, repo: string, sha: string): Promise<GitHubFetched<GitHubCommit>>;
  listPullRequests(owner: string, repo: string): AsyncIterable<GitHubFetched<GitHubPullRequest>>;
  listPullCommits(owner: string, repo: string, pullNumber: number): AsyncIterable<GitHubFetched<GitHubCommit>>;
  listPullFiles(owner: string, repo: string, pullNumber: number): AsyncIterable<GitHubFetched<GitHubFileChange>>;
  listReviews(owner: string, repo: string, pullNumber: number): AsyncIterable<GitHubFetched<GitHubReview>>;
  listReviewComments(owner: string, repo: string, pullNumber: number): AsyncIterable<GitHubFetched<GitHubReviewComment>>;
  listIssueComments(owner: string, repo: string, pullNumber: number): AsyncIterable<GitHubFetched<GitHubIssueComment>>;
  listWorkflowRuns(owner: string, repo: string): AsyncIterable<GitHubFetched<GitHubWorkflowRun>>;
  listWorkflowJobs(owner: string, repo: string, runId: number): AsyncIterable<GitHubFetched<GitHubWorkflowJob>>;
}
