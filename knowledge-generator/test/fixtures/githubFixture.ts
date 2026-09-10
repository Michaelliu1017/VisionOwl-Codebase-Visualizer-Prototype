import type {
  GitHubClientPort,
  GitHubCommit,
  GitHubFetched,
  GitHubFileChange,
  GitHubIssueComment,
  GitHubPullRequest,
  GitHubRepository,
  GitHubReview,
  GitHubReviewComment,
  GitHubWorkflowJob,
  GitHubWorkflowRun,
} from "../../src/github/types.js";

export const SHA_ONE = "1111111111111111111111111111111111111111";
export const SHA_TWO = "2222222222222222222222222222222222222222";

const owner = { id: 1, login: "visionowl", html_url: "https://github.com/visionowl" };
const author = { id: 2, login: "developer", html_url: "https://github.com/developer" };
const reviewer = { id: 3, login: "reviewer", html_url: "https://github.com/reviewer" };

export const repository: GitHubRepository = {
  id: 101,
  name: "evidence-fixture",
  full_name: "visionowl/evidence-fixture",
  description: "Controlled repository for Evidence Graph tests",
  html_url: "https://github.com/visionowl/evidence-fixture",
  default_branch: "main",
  private: false,
  language: "TypeScript",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
  pushed_at: "2026-08-01T00:00:00Z",
  owner,
};

export const commitOne: GitHubCommit = {
  sha: SHA_ONE,
  html_url: `https://github.com/visionowl/evidence-fixture/commit/${SHA_ONE}`,
  author,
  committer: author,
  commit: {
    message: "feat: add retry client",
    author: { name: "Developer", date: "2026-07-30T10:00:00Z" },
    committer: { name: "Developer", date: "2026-07-30T10:00:00Z" },
    verification: { verified: true },
  },
  parents: [],
  stats: { additions: 20, deletions: 0, total: 20 },
  files: [
    {
      filename: "README.md",
      status: "added",
      additions: 20,
      deletions: 0,
      changes: 20,
      blob_url: `https://github.com/visionowl/evidence-fixture/blob/${SHA_ONE}/README.md`,
      patch: "+retry client",
    },
  ],
};

export const commitTwo: GitHubCommit = {
  sha: SHA_TWO,
  html_url: `https://github.com/visionowl/evidence-fixture/commit/${SHA_TWO}`,
  author,
  committer: author,
  commit: {
    message: "fix: bound Redis retry attempts",
    author: { name: "Developer", date: "2026-08-01T10:00:00Z" },
    committer: { name: "Developer", date: "2026-08-01T10:00:00Z" },
    verification: { verified: true },
  },
  parents: [{ sha: SHA_ONE }],
  stats: { additions: 18, deletions: 4, total: 22 },
  files: [
    {
      filename: "src/retry.ts",
      status: "modified",
      additions: 18,
      deletions: 4,
      changes: 22,
      blob_url: `https://github.com/visionowl/evidence-fixture/blob/${SHA_TWO}/src/retry.ts`,
      patch: "+const maxAttempts = 3",
    },
  ],
};

export const pullRequest: GitHubPullRequest = {
  id: 201,
  number: 7,
  html_url: "https://github.com/visionowl/evidence-fixture/pull/7",
  state: "closed",
  title: "Bound Redis retries",
  body: "Prevent a worker from retrying forever.",
  user: author,
  merged: true,
  merged_at: "2026-08-01T12:00:00Z",
  closed_at: "2026-08-01T12:00:00Z",
  created_at: "2026-07-30T09:00:00Z",
  updated_at: "2026-08-01T12:00:00Z",
  merge_commit_sha: SHA_TWO,
  head: { ref: "fix/retry", sha: SHA_TWO },
  base: { ref: "main", sha: SHA_ONE },
  labels: [{ id: 1, name: "reliability" }],
  requested_reviewers: [reviewer],
};

const pullFile: GitHubFileChange = {
  filename: "src/retry.ts",
  status: "modified",
  additions: 18,
  deletions: 4,
  changes: 22,
  blob_url: `https://github.com/visionowl/evidence-fixture/blob/${SHA_TWO}/src/retry.ts`,
  patch: "+const maxAttempts = 3",
};

const reviews: GitHubReview[] = [
  {
    id: 301,
    html_url: "https://github.com/visionowl/evidence-fixture/pull/7#pullrequestreview-301",
    user: reviewer,
    body: "Retry must have an upper limit.",
    state: "CHANGES_REQUESTED",
    commit_id: SHA_ONE,
    submitted_at: "2026-07-31T08:00:00Z",
  },
  {
    id: 302,
    html_url: "https://github.com/visionowl/evidence-fixture/pull/7#pullrequestreview-302",
    user: reviewer,
    body: "The bounded retry and test are correct.",
    state: "APPROVED",
    commit_id: SHA_TWO,
    submitted_at: "2026-08-01T11:00:00Z",
  },
];

const reviewComments: GitHubReviewComment[] = [
  {
    id: 401,
    html_url: "https://github.com/visionowl/evidence-fixture/pull/7#discussion_r401",
    user: reviewer,
    body: "An unbounded loop can block the worker.",
    created_at: "2026-07-31T08:01:00Z",
    updated_at: "2026-07-31T08:01:00Z",
    pull_request_review_id: 301,
    commit_id: SHA_ONE,
    path: "src/retry.ts",
    line: 10,
    side: "RIGHT",
  },
  {
    id: 402,
    html_url: "https://github.com/visionowl/evidence-fixture/pull/7#discussion_r402",
    user: author,
    body: "Fixed with maxAttempts=3 and exponential backoff.",
    created_at: "2026-08-01T10:10:00Z",
    updated_at: "2026-08-01T10:10:00Z",
    pull_request_review_id: 301,
    commit_id: SHA_TWO,
    path: "src/retry.ts",
    line: 12,
    side: "RIGHT",
    in_reply_to_id: 401,
  },
];

const issueComments: GitHubIssueComment[] = [
  {
    id: 501,
    html_url: "https://github.com/visionowl/evidence-fixture/pull/7#issuecomment-501",
    user: author,
    body: "CI is green after adding the bounded retry test.",
    created_at: "2026-08-01T11:30:00Z",
    updated_at: "2026-08-01T11:30:00Z",
  },
];

const workflowRuns: GitHubWorkflowRun[] = [
  {
    id: 601,
    name: "CI",
    display_title: "Unbounded retry test",
    html_url: "https://github.com/visionowl/evidence-fixture/actions/runs/601",
    event: "pull_request",
    status: "completed",
    conclusion: "failure",
    workflow_id: 60,
    run_number: 1,
    head_branch: "fix/retry",
    head_sha: SHA_ONE,
    created_at: "2026-07-31T09:00:00Z",
    updated_at: "2026-07-31T09:05:00Z",
    actor: author,
    pull_requests: [{ id: 201, number: 7 }],
  },
  {
    id: 602,
    name: "CI",
    display_title: "Bounded retry test",
    html_url: "https://github.com/visionowl/evidence-fixture/actions/runs/602",
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    workflow_id: 60,
    run_number: 2,
    head_branch: "fix/retry",
    head_sha: SHA_TWO,
    created_at: "2026-08-01T10:20:00Z",
    updated_at: "2026-08-01T10:25:00Z",
    actor: author,
    pull_requests: [{ id: 201, number: 7 }],
  },
];

const jobsByRun = new Map<number, GitHubWorkflowJob[]>([
  [
    601,
    [
      {
        id: 701,
        run_id: 601,
        html_url: "https://github.com/visionowl/evidence-fixture/actions/runs/601/job/701",
        name: "test",
        status: "completed",
        conclusion: "failure",
        head_sha: SHA_ONE,
        started_at: "2026-07-31T09:00:00Z",
        completed_at: "2026-07-31T09:05:00Z",
        steps: [{ name: "retry timeout test", status: "completed", conclusion: "failure", number: 1 }],
      },
    ],
  ],
  [
    602,
    [
      {
        id: 702,
        run_id: 602,
        html_url: "https://github.com/visionowl/evidence-fixture/actions/runs/602/job/702",
        name: "test",
        status: "completed",
        conclusion: "success",
        head_sha: SHA_TWO,
        started_at: "2026-08-01T10:20:00Z",
        completed_at: "2026-08-01T10:25:00Z",
        steps: [{ name: "bounded retry test", status: "completed", conclusion: "success", number: 1 }],
      },
    ],
  ],
]);

export class FixtureGitHubClient implements GitHubClientPort {
  requestCount = 0;

  async getRepository(): Promise<GitHubFetched<GitHubRepository>> {
    this.requestCount += 1;
    return fetched("repository", repository);
  }

  listCommits(): AsyncIterable<GitHubFetched<GitHubCommit>> {
    this.requestCount += 1;
    return fetchedIterable("commits", [commitTwo, commitOne]);
  }

  async getCommit(_owner: string, _repo: string, sha: string): Promise<GitHubFetched<GitHubCommit>> {
    this.requestCount += 1;
    const commit = sha === SHA_ONE ? commitOne : sha === SHA_TWO ? commitTwo : undefined;
    if (!commit) throw new Error(`unknown fixture commit ${sha}`);
    return fetched(`commits/${sha}`, commit);
  }

  listPullRequests(): AsyncIterable<GitHubFetched<GitHubPullRequest>> {
    this.requestCount += 1;
    return fetchedIterable("pulls", [pullRequest]);
  }

  listPullCommits(): AsyncIterable<GitHubFetched<GitHubCommit>> {
    this.requestCount += 1;
    return fetchedIterable("pulls/7/commits", [commitOne, commitTwo]);
  }

  listPullFiles(): AsyncIterable<GitHubFetched<GitHubFileChange>> {
    this.requestCount += 1;
    return fetchedIterable("pulls/7/files", [pullFile]);
  }

  listReviews(): AsyncIterable<GitHubFetched<GitHubReview>> {
    this.requestCount += 1;
    return fetchedIterable("pulls/7/reviews", reviews);
  }

  listReviewComments(): AsyncIterable<GitHubFetched<GitHubReviewComment>> {
    this.requestCount += 1;
    return fetchedIterable("pulls/7/comments", reviewComments);
  }

  listIssueComments(): AsyncIterable<GitHubFetched<GitHubIssueComment>> {
    this.requestCount += 1;
    return fetchedIterable("issues/7/comments", issueComments);
  }

  listWorkflowRuns(): AsyncIterable<GitHubFetched<GitHubWorkflowRun>> {
    this.requestCount += 1;
    return fetchedIterable("actions/runs", workflowRuns);
  }

  listWorkflowJobs(_owner: string, _repo: string, runId: number): AsyncIterable<GitHubFetched<GitHubWorkflowJob>> {
    this.requestCount += 1;
    return fetchedIterable(`actions/runs/${runId}/jobs`, jobsByRun.get(runId) ?? []);
  }
}

function fetched<T>(path: string, data: T): GitHubFetched<T> {
  return { data: structuredClone(data), requestUrl: `https://api.github.test/repos/visionowl/evidence-fixture/${path}` };
}

async function* fetchedIterable<T>(path: string, values: T[]): AsyncIterable<GitHubFetched<T>> {
  for (const value of values) yield fetched(path, value);
}
