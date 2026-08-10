import assert from "node:assert/strict";
import test from "node:test";

import { assessKnowledgeFreshness } from "../src/index.js";

test("reports fresh knowledge for the same recent commit", () => {
  const result = assessKnowledgeFreshness({
    sourceCommitSha: "abc123",
    currentCommitSha: "abc123",
    generatedAt: "2026-08-10T00:00:00.000Z",
    now: Date.parse("2026-08-10T01:00:00.000Z"),
  });

  assert.deepEqual(result, {
    status: "fresh",
    reasons: [],
    ageMs: 60 * 60 * 1000,
  });
});

test("reports stale knowledge after the repository commit changes", () => {
  const result = assessKnowledgeFreshness({
    sourceCommitSha: "abc123",
    currentCommitSha: "def456",
    generatedAt: "2026-08-10T00:00:00.000Z",
    now: Date.parse("2026-08-10T01:00:00.000Z"),
  });

  assert.equal(result.status, "stale");
  assert.deepEqual(result.reasons, ["commit_changed"]);
});
