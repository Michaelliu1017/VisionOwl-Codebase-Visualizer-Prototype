import assert from "node:assert/strict";
import test from "node:test";
import { GitHubClient, parseNextLink } from "../../src/github/client.js";

test("parses the next pagination link", () => {
  assert.equal(
    parseNextLink('<https://api.github.test/page/1>; rel="prev", <https://api.github.test/page/3>; rel="next"'),
    "https://api.github.test/page/3",
  );
  assert.equal(parseNextLink(null), undefined);
});

test("paginates array responses and preserves request provenance", async () => {
  const responses = new Map<string, Response>([
    [
      "https://api.github.test/repos/a/b/commits?sha=main&per_page=100",
      jsonResponse([{ sha: "one" }], {
        url: "https://api.github.test/repos/a/b/commits?sha=main&per_page=100",
        link: '<https://api.github.test/repos/a/b/commits?page=2>; rel="next"',
      }),
    ],
    [
      "https://api.github.test/repos/a/b/commits?page=2",
      jsonResponse([{ sha: "two" }], { url: "https://api.github.test/repos/a/b/commits?page=2" }),
    ],
  ]);
  const client = new GitHubClient({
    baseUrl: "https://api.github.test",
    fetchImpl: async (input) => {
      const response = responses.get(String(input));
      if (!response) throw new Error(`unexpected request ${String(input)}`);
      return response.clone();
    },
  });
  const items = [];
  for await (const item of client.listCommits("a", "b", "main")) items.push(item.data.sha);
  assert.deepEqual(items, ["one", "two"]);
  assert.equal(client.requestCount, 2);
});

test("retries a transient rate limit response", async () => {
  let attempts = 0;
  const waits: number[] = [];
  const client = new GitHubClient({
    baseUrl: "https://api.github.test",
    maxRetries: 1,
    fetchImpl: async (input) => {
      attempts += 1;
      if (attempts === 1) {
        const response = new Response(JSON.stringify({ message: "secondary rate limit" }), {
          status: 429,
          headers: { "retry-after": "0" },
        });
        Object.defineProperty(response, "url", { value: String(input) });
        return response;
      }
      return jsonResponse(
        {
          id: 1,
          name: "b",
          full_name: "a/b",
          html_url: "https://github.com/a/b",
          default_branch: "main",
          private: false,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          owner: { id: 1, login: "a", html_url: "https://github.com/a" },
        },
        { url: String(input) },
      );
    },
    onRateLimitWait: (waitMs) => waits.push(waitMs),
  });

  const result = await client.getRepository("a", "b");
  assert.equal(result.data.full_name, "a/b");
  assert.equal(client.requestCount, 2);
  assert.deepEqual(waits, [0]);
});

function jsonResponse(body: unknown, options: { url: string; link?: string }): Response {
  const response = new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(options.link ? { link: options.link } : {}) },
  });
  Object.defineProperty(response, "url", { value: options.url });
  return response;
}
