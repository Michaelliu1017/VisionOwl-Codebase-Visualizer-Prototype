export interface ResolvedGitHubSource {
  provider: "github";
  owner: string;
  repo: string;
  canonicalUrl: string;
}

export function resolveGitHubSource(repoUrl: string): ResolvedGitHubSource {
  let parsed: URL;
  try {
    parsed = new URL(repoUrl.trim());
  } catch {
    throw new Error("repoUrl must be a valid HTTPS GitHub repository URL");
  }

  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") {
    throw new Error("stage 1 only accepts public https://github.com repositories");
  }

  const segments = parsed.pathname
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
  if (segments.length !== 2) {
    throw new Error("repoUrl must point to a repository root: https://github.com/{owner}/{repo}");
  }

  const owner = segments[0];
  const repo = segments[1]?.replace(/\.git$/i, "");
  if (!owner || !repo || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("repoUrl contains an invalid owner or repository name");
  }

  return {
    provider: "github",
    owner,
    repo,
    canonicalUrl: `https://github.com/${owner}/${repo}`,
  };
}
