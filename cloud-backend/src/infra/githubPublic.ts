import { badRequest, rateLimited } from "../lib/errors";

const GITHUB_API = "https://api.github.com";

export interface PublicRepository {
  id: number;
  fullName: string;
  defaultBranch: string;
  htmlUrl: string;
}

export interface PublicBranch {
  name: string;
  commitSha: string;
}

function headers(): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "visionowl-cloud",
  };
}

async function githubFetch(path: string): Promise<Response> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    headers: headers(),
    signal: AbortSignal.timeout(15_000),
  }).catch((error: unknown) => {
    throw badRequest(`无法访问 GitHub：${error instanceof Error ? error.message : String(error)}`);
  });
  if (response.status === 403 || response.status === 429) {
    throw rateLimited("GitHub API 限流，请稍后重试");
  }
  if (!response.ok) {
    throw badRequest(response.status === 404 ? "公开仓库不存在或不可访问" : `GitHub API 返回 HTTP ${response.status}`);
  }
  return response;
}

export async function getPublicRepository(repoFullName: string): Promise<PublicRepository> {
  const response = await githubFetch(`/repos/${repoFullName}`);
  const body = (await response.json()) as {
    id?: number;
    full_name?: string;
    default_branch?: string;
    html_url?: string;
    private?: boolean;
  };
  if (body.private || !body.id || !body.full_name || !body.default_branch) {
    throw badRequest("当前演示仅支持公开 GitHub 仓库");
  }
  return {
    id: body.id,
    fullName: body.full_name,
    defaultBranch: body.default_branch,
    htmlUrl: body.html_url ?? `https://github.com/${body.full_name}`,
  };
}

export async function listPublicBranches(repoFullName: string): Promise<PublicBranch[]> {
  const repository = await getPublicRepository(repoFullName);
  const response = await githubFetch(`/repos/${repoFullName}/branches?per_page=100`);
  const body = (await response.json()) as Array<{ name?: string; commit?: { sha?: string } }>;
  const branches = body
    .filter((branch) => Boolean(branch.name && branch.commit?.sha))
    .map((branch) => ({ name: branch.name!, commitSha: branch.commit!.sha! }));

  const listedDefault = branches.find((branch) => branch.name === repository.defaultBranch);
  const defaultCommitSha = listedDefault?.commitSha
    ?? await getPublicBranchHeadSha(repoFullName, repository.defaultBranch).catch(() => "");

  return [
    { name: repository.defaultBranch, commitSha: defaultCommitSha },
    ...branches.filter((branch) => branch.name !== repository.defaultBranch),
  ];
}

export async function getPublicBranchHeadSha(
  repoFullName: string,
  branch: string,
): Promise<string> {
  const response = await githubFetch(
    `/repos/${repoFullName}/branches/${encodeURIComponent(branch)}`,
  );
  const body = (await response.json()) as { commit?: { sha?: string } };
  if (!body.commit?.sha) throw badRequest("GitHub 未返回分支 HEAD SHA");
  return body.commit.sha;
}
