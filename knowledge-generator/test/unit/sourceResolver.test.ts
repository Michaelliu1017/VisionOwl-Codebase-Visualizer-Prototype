import assert from "node:assert/strict";
import test from "node:test";
import { resolveGitHubSource } from "../../src/domain/sourceResolver.js";

test("resolves and canonicalizes a public GitHub repository URL", () => {
  assert.deepEqual(resolveGitHubSource("https://github.com/Owner/Repo.git?tab=readme"), {
    provider: "github",
    owner: "Owner",
    repo: "Repo",
    canonicalUrl: "https://github.com/Owner/Repo",
  });
});

test("rejects non-GitHub URLs and nested paths", () => {
  assert.throws(() => resolveGitHubSource("https://gitlab.com/owner/repo"), /only accepts/);
  assert.throws(() => resolveGitHubSource("https://github.com/owner/repo/tree/main"), /repository root/);
  assert.throws(() => resolveGitHubSource("git@github.com:owner/repo.git"), /valid HTTPS/);
});
