"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const {
  runDirectUnderstandAnything,
} = require("../src/core/direct-understand-engine");
const {
  findUnderstandSkillPath,
  repositoryUnchanged,
} = require("../src/core/understand-anything");

test(
  "direct engine runs the original Understand Anything scripts and publishes partial graphs",
  { timeout: 120000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "visionowl-direct-"));
    const previousCodex = process.env.VISIONOWL_CODEX_ENABLED;
    process.env.VISIONOWL_CODEX_ENABLED = "false";
    try {
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify(
          {
            name: "visionowl-direct-fixture",
            private: true,
            type: "module",
          },
          null,
          2,
        ),
      );
      fs.writeFileSync(
        path.join(root, "README.md"),
        "# Direct Fixture\n\nA small repository for direct engine validation.\n",
      );
      fs.writeFileSync(
        path.join(root, "main.js"),
        'import { greet } from "./util.js";\nconsole.log(greet("VisionOwl"));\n',
      );
      fs.writeFileSync(
        path.join(root, "util.js"),
        'export function greet(name) {\n  return `hello ${name}`;\n}\n',
      );
      fs.writeFileSync(path.join(root, ".DS_Store"), "finder metadata");
      fs.writeFileSync(path.join(root, "ignored.log"), "runtime output");
      fs.writeFileSync(path.join(root, ".gitignore"), "*.log\n");
      execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=VisionOwl",
          "-c",
          "user.email=visionowl@example.invalid",
          "commit",
          "-m",
          "initial",
        ],
        { cwd: root, stdio: "ignore" },
      );
      const initialCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim();
      const dataDir = path.join(root, ".ua");
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(
        path.join(dataDir, "meta.json"),
        JSON.stringify({
          gitCommitHash: initialCommit,
          version: "1.0.0",
        }),
      );
      fs.writeFileSync(
        path.join(dataDir, "knowledge-graph.json"),
        JSON.stringify({
          version: "1.0.0",
          kind: "codebase",
          project: { name: "legacy-result" },
          nodes: [],
          edges: [],
          layers: [],
          tour: [],
        }),
      );

      const phases = [];
      const partialPhases = [];
      const skillPath = findUnderstandSkillPath();
      const result = await runDirectUnderstandAnything({
        repoPath: root,
        skillPath,
        dataDir,
        repositoryUnchanged,
        onProgress: (phase) => phases.push(phase),
        onGraph: (_graph, state) => partialPhases.push(state.phase),
      });

      assert.equal(result.engine, "direct");
      assert.equal(result.reused, false);
      assert.ok(
        result.knowledgeGraph.nodes.some((node) => node.id === "file:main.js"),
      );
      assert.equal(
        result.knowledgeGraph.nodes.some(
          (node) =>
            node.filePath === ".DS_Store" || node.filePath === "ignored.log",
        ),
        false,
      );
      assert.ok(
        result.knowledgeGraph.nodes.some(
          (node) => node.id === "function:util.js:greet",
        ),
      );
      assert.ok(
        result.knowledgeGraph.edges.some(
          (edge) =>
            edge.source === "file:main.js" &&
            edge.target === "file:util.js" &&
            edge.type === "imports",
        ),
      );
      assert.ok(result.knowledgeGraph.layers.length >= 3);
      assert.deepEqual(partialPhases, [
        "facts_ready",
        "enriching",
        "architecture_ready",
      ]);
      assert.ok(phases.includes("ua_tour"));
      assert.ok(phases.includes("ua_save"));
      assert.ok(fs.existsSync(path.join(root, ".ua", "fingerprints.json")));

      const reused = await runDirectUnderstandAnything({
        repoPath: root,
        skillPath,
        dataDir,
        repositoryUnchanged,
      });
      assert.equal(reused.reused, true);
    } finally {
      if (previousCodex === undefined) {
        delete process.env.VISIONOWL_CODEX_ENABLED;
      } else {
        process.env.VISIONOWL_CODEX_ENABLED = previousCodex;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
