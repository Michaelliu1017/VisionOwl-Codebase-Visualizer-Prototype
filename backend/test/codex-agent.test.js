"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runCodex } = require("../src/core/codex-agent");

test("runCodex streams large prompts through stdin", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "visionowl-codex-stdin-"));
  const binary = path.join(root, "fake-codex.cjs");
  const previousBinary = process.env.CODEX_BIN;
  t.after(() => {
    if (previousBinary === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previousBinary;
    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.writeFileSync(
    binary,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      "const args = process.argv.slice(2);",
      'const outputIndex = args.indexOf("--output-last-message");',
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { input += chunk; });',
      'process.stdin.on("end", () => {',
      "  fs.writeFileSync(args[outputIndex + 1], JSON.stringify({ length: input.length }));",
      '  process.stdout.write(JSON.stringify({ thread_id: "fake-thread" }) + "\\n");',
      "});",
      "",
    ].join("\n"),
  );
  fs.chmodSync(binary, 0o755);
  process.env.CODEX_BIN = binary;

  const prompt = "x".repeat(512 * 1024);
  const result = await runCodex({
    repoPath: root,
    prompt,
    timeoutMs: 5000,
  });

  assert.equal(JSON.parse(result.content).length, prompt.length);
  assert.equal(result.threadId, "fake-thread");
});
