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
} from "./types.js";

export interface GitHubClientOptions {
  token?: string;
  baseUrl?: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  maxRateLimitWaitMs?: number;
  onRateLimitWait?: (waitMs: number, response: Response) => void;
}

interface GitHubPage<T> {
  items: T[];
  requestUrl: string;
  etag?: string;
  nextUrl?: string;
}

export class GitHubClient implements GitHubClientPort {
  public requestCount = 0;

  private readonly token?: string;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly maxRateLimitWaitMs: number;
  private readonly onRateLimitWait?: (waitMs: number, response: Response) => void;

  constructor(options: GitHubClientOptions = {}) {
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.apiVersion = options.apiVersion ?? "2022-11-28";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 3;
    this.maxRateLimitWaitMs = options.maxRateLimitWaitMs ?? 30_000;
    this.onRateLimitWait = options.onRateLimitWait;
  }

  async getRepository(owner: string, repo: string): Promise<GitHubFetched<GitHubRepository>> {
    return this.getOne<GitHubRepository>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  }

  listCommits(owner: string, repo: string, branch: string, since?: string): AsyncIterable<GitHubFetched<GitHubCommit>> {
    const params = new URLSearchParams({ sha: branch, per_page: "100" });
    if (since) params.set("since", since);
    return this.paginate<GitHubCommit>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?${params}`);
  }

  getCommit(owner: string, repo: string, sha: string): Promise<GitHubFetched<GitHubCommit>> {
    return this.getOne<GitHubCommit>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}`);
  }

  listPullRequests(owner: string, repo: string): AsyncIterable<GitHubFetched<GitHubPullRequest>> {
    return this.paginate<GitHubPullRequest>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=all&sort=updated&direction=desc&per_page=100`,
    );
  }

  listPullCommits(owner: string, repo: string, pullNumber: number): AsyncIterable<GitHubFetched<GitHubCommit>> {
    return this.paginate<GitHubCommit>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/commits?per_page=100`,
    );
  }

  listPullFiles(owner: string, repo: string, pullNumber: number): AsyncIterable<GitHubFetched<GitHubFileChange>> {
    return this.paginate<GitHubFileChange>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/files?per_page=100`,
    );
  }

  listReviews(owner: string, repo: string, pullNumber: number): AsyncIterable<GitHubFetched<GitHubReview>> {
    return this.paginate<GitHubReview>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/reviews?per_page=100`,
    );
  }

  listReviewComments(owner: string, repo: string, pullNumber: number): AsyncIterable<GitHubFetched<GitHubReviewComment>> {
    return this.paginate<GitHubReviewComment>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/comments?per_page=100`,
    );
  }

  listIssueComments(owner: string, repo: string, pullNumber: number): AsyncIterable<GitHubFetched<GitHubIssueComment>> {
    return this.paginate<GitHubIssueComment>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${pullNumber}/comments?per_page=100`,
    );
  }

  listWorkflowRuns(owner: string, repo: string): AsyncIterable<GitHubFetched<GitHubWorkflowRun>> {
    return this.paginate<GitHubWorkflowRun>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs?per_page=100`,
      "workflow_runs",
    );
  }

  listWorkflowJobs(owner: string, repo: string, runId: number): AsyncIterable<GitHubFetched<GitHubWorkflowJob>> {
    return this.paginate<GitHubWorkflowJob>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/jobs?filter=all&per_page=100`,
      "jobs",
    );
  }

  private async getOne<T>(pathOrUrl: string): Promise<GitHubFetched<T>> {
    const response = await this.request(pathOrUrl);
    const data = (await response.json()) as T;
    return {
      data,
      requestUrl: response.url,
      etag: response.headers.get("etag") ?? undefined,
    };
  }

  private async *paginate<T>(pathOrUrl: string, arrayKey?: string): AsyncIterable<GitHubFetched<T>> {
    let nextUrl: string | undefined = this.absoluteUrl(pathOrUrl);
    while (nextUrl) {
      const page: GitHubPage<T> = await this.getPage<T>(nextUrl, arrayKey);
      for (const data of page.items) {
        yield { data, requestUrl: page.requestUrl, etag: page.etag };
      }
      nextUrl = page.nextUrl;
    }
  }

  private async getPage<T>(url: string, arrayKey?: string): Promise<GitHubPage<T>> {
    const response = await this.request(url);
    const body = (await response.json()) as unknown;
    const items = arrayKey
      ? (body as Record<string, unknown>)[arrayKey]
      : body;
    if (!Array.isArray(items)) {
      throw new Error(`GitHub response at ${response.url} did not contain an array${arrayKey ? ` in ${arrayKey}` : ""}`);
    }
    return {
      items: items as T[],
      requestUrl: response.url,
      etag: response.headers.get("etag") ?? undefined,
      nextUrl: parseNextLink(response.headers.get("link")),
    };
  }

  private async request(pathOrUrl: string): Promise<Response> {
    const url = this.absoluteUrl(pathOrUrl);
    let attempt = 0;
    while (true) {
      this.requestCount += 1;
      const response = await this.fetchImpl(url, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": this.apiVersion,
          "User-Agent": "VisionOwl-Knowledge-Generator/0.1",
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
      });

      if (response.ok) return response;

      const retryable = response.status === 429 || response.status >= 500 || response.status === 403;
      if (!retryable || attempt >= this.maxRetries) {
        const body = await safeResponseText(response);
        throw new GitHubApiError(response.status, url, body, response.headers);
      }

      const waitMs = calculateRetryWaitMs(response, attempt);
      if (waitMs > this.maxRateLimitWaitMs) {
        throw new GitHubApiError(
          response.status,
          url,
          `retry requires waiting ${waitMs}ms, exceeding configured maximum`,
          response.headers,
        );
      }
      this.onRateLimitWait?.(waitMs, response);
      await sleep(waitMs);
      attempt += 1;
    }
  }

  private absoluteUrl(pathOrUrl: string): string {
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    return `${this.baseUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
  }
}

export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly requestUrl: string,
    public readonly responseBody: string,
    public readonly responseHeaders: Headers,
  ) {
    super(`GitHub API ${status} for ${requestUrl}: ${responseBody.slice(0, 500)}`);
    this.name = "GitHubApiError";
  }
}

export function parseNextLink(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined;
  for (const part of linkHeader.split(",")) {
    const match = part.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/);
    if (match?.[2] === "next") return match[1];
  }
  return undefined;
}

function calculateRetryWaitMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter && Number.isFinite(Number(retryAfter))) {
    return Math.max(0, Number(retryAfter) * 1_000);
  }
  const remaining = response.headers.get("x-ratelimit-remaining");
  const reset = response.headers.get("x-ratelimit-reset");
  if (remaining === "0" && reset && Number.isFinite(Number(reset))) {
    return Math.max(0, Number(reset) * 1_000 - Date.now() + 250);
  }
  const base = Math.min(1_000 * 2 ** attempt, 10_000);
  return base + Math.floor(Math.random() * Math.max(100, Math.floor(base * 0.2)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unable to read response body>";
  }
}
