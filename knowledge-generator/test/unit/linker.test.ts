import assert from "node:assert/strict";
import test from "node:test";
import { resolveLinks } from "../../src/evidence/linker.js";
import { normalizeRepository } from "../../src/evidence/normalizer.js";
import { repository } from "../fixtures/githubFixture.js";

test("creates a pending link instead of a dangling edge", () => {
  const nodes = normalizeRepository(repository, "raw:repository");
  const source = nodes.find((node) => node.kind === "repository");
  assert.ok(source);

  const result = resolveLinks(
    nodes,
    [
      {
        repositoryId: source.repositoryId,
        fromId: source.id,
        toId: "github:101:commit:missing",
        relationType: "REPOSITORY_HAS_EVIDENCE",
        basis: "test missing target",
      },
    ],
    "2026-08-09T12:00:00Z",
  );

  assert.equal(result.edges.length, 0);
  assert.equal(result.pendingLinks.length, 1);
  assert.equal(result.pendingLinks[0]?.expectedToId, "github:101:commit:missing");
});

test("deduplicates deterministic edges", () => {
  const nodes = normalizeRepository(repository, "raw:repository");
  const source = nodes.find((node) => node.kind === "repository");
  const actor = nodes.find((node) => node.kind === "actor");
  assert.ok(source && actor);
  const candidate = {
    repositoryId: source.repositoryId,
    fromId: actor.id,
    toId: source.id,
    relationType: "ACTOR_AUTHORED" as const,
    basis: "repository owner",
  };

  const result = resolveLinks(nodes, [candidate, candidate], "2026-08-09T12:00:00Z");
  assert.equal(result.edges.length, 1);
  assert.equal(result.pendingLinks.length, 0);
});
