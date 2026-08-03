"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  sanitizeGraphArtifact,
  validateSanitizedGraphArtifact,
} = require("../../packages/graph-sanitizer");

function fixture(root) {
  return {
    project: { id: "project-1", name: "TestRepo", branch: "master" },
    graph: {
      branch: "master",
      commit: "abc123",
      entities: [
        {
          id: "module:api",
          category: "code",
          kind: "module",
          name: "API",
          summary: "HTTP boundary",
          status: "healthy",
          path: path.join(root, "src", "api"),
          tags: ["http"],
          metadata: { files: ["src/api/index.js"], access_token: "must-not-leak" },
          evidence: [
            {
              file: path.join(root, "src", "api", "index.js"),
              line: 4,
              excerpt: "const secret = process.env.SECRET;",
            },
          ],
        },
      ],
      relations: [],
      executionFlows: [],
    },
  };
}

test("graph sanitizer emits repository-relative evidence without source excerpts", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "visionowl-sanitizer-"));
  fs.mkdirSync(path.join(root, "src", "api"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "api", "index.js"), "module.exports = true;\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = fixture(root);
  const artifact = sanitizeGraphArtifact({ ...input, repositoryRoot: root });

  assert.equal(artifact.graph.entities[0].path, "src/api");
  assert.equal(artifact.graph.entities[0].evidence[0].file, "src/api/index.js");
  assert.equal("excerpt" in artifact.graph.entities[0].evidence[0], false);
  assert.equal("access_token" in artifact.graph.entities[0].metadata, false);
  assert.equal(
    validateSanitizedGraphArtifact(artifact, { projectId: "project-1" }),
    artifact,
  );
});

test("graph sanitizer rejects secrets in publishable text", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "visionowl-sanitizer-secret-"));
  fs.mkdirSync(path.join(root, "src", "api"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "api", "index.js"), "module.exports = true;\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = fixture(root);
  input.graph.entities[0].summary = `token=${"x".repeat(24)}`;

  assert.throws(
    () => sanitizeGraphArtifact({ ...input, repositoryRoot: root }),
    { code: "sanitized_graph_sensitive_data" },
  );
});

test("artifact validation independently rejects host paths and broken relations", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "visionowl-sanitizer-validate-"));
  fs.mkdirSync(path.join(root, "src", "api"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "api", "index.js"), "module.exports = true;\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifact = sanitizeGraphArtifact({ ...fixture(root), repositoryRoot: root });
  artifact.graph.entities[0].metadata = { localPath: "/Users/example/private.txt" };
  assert.throws(() => validateSanitizedGraphArtifact(artifact), {
    code: "sanitized_graph_invalid",
  });

  artifact.graph.entities[0].metadata = {};
  artifact.graph.relations.push({
    id: "missing-target",
    source: "module:api",
    target: "module:missing",
    type: "calls",
    label: "calls",
    status: "healthy",
    directed: true,
    generated: false,
    metadata: {},
    evidence: [],
  });
  assert.throws(() => validateSanitizedGraphArtifact(artifact), {
    code: "sanitized_graph_invalid",
  });
});
