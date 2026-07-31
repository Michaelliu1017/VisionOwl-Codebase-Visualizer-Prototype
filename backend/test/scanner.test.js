"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { scanRepository } = require("../src/core/scanner");

function fixtureRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "visionowl-scanner-"));
  fs.mkdirSync(path.join(root, "src", "api"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "core"), { recursive: true });
  fs.mkdirSync(path.join(root, "packages", "contracts", "src"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "scanner-fixture",
      private: true,
      workspaces: ["packages/*"],
    }),
  );
  fs.writeFileSync(
    path.join(root, "packages", "contracts", "package.json"),
    JSON.stringify({
      name: "@fixture/contracts",
      exports: { ".": "./src/index.ts" },
    }),
  );
  fs.writeFileSync(
    path.join(root, "packages", "contracts", "src", "index.ts"),
    "export type Contract = { value: string };\n",
  );
  fs.writeFileSync(
    path.join(root, "src", "core", "format.ts"),
    "export const format = (value: string) => value.trim();\n",
  );
  fs.writeFileSync(
    path.join(root, "src", "api", "handler.ts"),
    [
      'import { format } from "../core/format";',
      'import type { Contract } from "@fixture/contracts";',
      "export function handler(value: string) {",
      "  return { value: format(value) } satisfies Contract;",
      "}",
      "",
    ].join("\n"),
  );
  return root;
}

test("scanner builds evidence-backed module and dependency relations", (t) => {
  const repoPath = fixtureRepository();
  t.after(() => fs.rmSync(repoPath, { recursive: true, force: true }));
  const checkpoints = [];

  const graph = scanRepository(repoPath, {
    id: "project-test",
    name: "Scanner fixture",
    description: "A deterministic scanner fixture.",
  }, (phase, progress, message) => {
    checkpoints.push({ phase, progress, message });
  });

  const modules = graph.entities.filter((entity) => entity.kind === "module");
  assert.equal(graph.entities.some((entity) => entity.kind === "project"), false);
  assert.equal(graph.relations.some((relation) => relation.type === "contains"), false);
  assert.deepEqual(
    modules.map((module) => module.path).sort(),
    ["packages/contracts", "src/api", "src/core"],
  );

  const api = modules.find((module) => module.path === "src/api");
  const core = modules.find((module) => module.path === "src/core");
  const dependency = graph.relations.find(
    (relation) =>
      relation.type === "depends_on" &&
      relation.source === api.id &&
      relation.target === core.id,
  );

  assert.ok(dependency, "expected src/api -> src/core dependency");
  assert.equal(dependency.generated, true);
  assert.equal(dependency.evidence[0].file, "src/api/handler.ts");
  assert.equal(dependency.evidence[0].line, 1);
  assert.match(dependency.evidence[0].excerpt, /import/);

  const contracts = modules.find(
    (module) => module.path === "packages/contracts",
  );
  const workspaceDependency = graph.relations.find(
    (relation) =>
      relation.type === "depends_on" &&
      relation.source === api.id &&
      relation.target === contracts.id,
  );
  assert.ok(workspaceDependency, "expected local workspace package dependency");
  assert.equal(workspaceDependency.evidence[0].line, 2);
  assert.ok(checkpoints.some((checkpoint) => checkpoint.phase === "inventory"));
  assert.ok(checkpoints.some((checkpoint) => checkpoint.phase === "facts"));
  assert.equal(checkpoints.at(-1).progress, 60);
  assert.ok(
    checkpoints.every(
      (checkpoint, index) =>
        index === 0 || checkpoint.progress >= checkpoints[index - 1].progress,
    ),
  );
});
