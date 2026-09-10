import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { validateSnapshot } from "./evidence/validator.js";
import { createKnowledgeProcessor } from "./knowledge/runtime.js";
import { createRuntime } from "./runtime.js";

const [command, ...args] = process.argv.slice(2);

if (command === "sync") {
  await runSync(args);
} else if (command === "process-run") {
  await runKnowledge(args);
} else if (command === "validate") {
  await runValidate(args);
} else {
  printUsage();
  process.exitCode = 1;
}

async function runKnowledge(args: string[]): Promise<void> {
  const values = parseArgs(args);
  const runId = values["run-id"];
  if (!runId) throw new Error("--run-id is required");
  const config = loadConfig({
    ...process.env,
    DATA_DIR: values["data-dir"] ?? process.env.DATA_DIR,
    CORE_BASE_URL: values["core-base-url"] ?? process.env.CORE_BASE_URL,
    CORE_SERVICE_TOKEN: values["core-service-token"] ?? process.env.CORE_SERVICE_TOKEN,
  });
  const runtime = await createRuntime(config);
  try {
    const result = await createKnowledgeProcessor(config, runtime).process(runId);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== "succeeded") process.exitCode = 1;
  } finally {
    await runtime.store.close();
  }
}

async function runSync(args: string[]): Promise<void> {
  const values = parseArgs(args);
  const repoUrl = values.repo;
  if (!repoUrl) throw new Error("--repo is required");
  const config = loadConfig({
    ...process.env,
    DATA_DIR: values["data-dir"] ?? process.env.DATA_DIR,
    STORAGE_DRIVER: values.storage ?? process.env.STORAGE_DRIVER,
  });
  const runtime = await createRuntime(config);
  try {
    const source = await runtime.orchestrator.registerSource({
      projectId: values["project-id"] ?? "standalone",
      repoUrl,
      branch: values.branch,
      historySince: values.since,
    });
    const run = await runtime.orchestrator.runSync(source.id, {
      historySince: values.since,
      maxItems: numberArg(values["max-items"]),
      maxConcurrency: numberArg(values.concurrency),
    });
    process.stdout.write(`${JSON.stringify({ source, run }, null, 2)}\n`);
    if (run.status !== "succeeded") process.exitCode = 1;
  } finally {
    await runtime.store.close();
  }
}

async function runValidate(args: string[]): Promise<void> {
  const values = parseArgs(args);
  const snapshotPath = values.snapshot;
  if (!snapshotPath) throw new Error("--snapshot is required");
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  const report = validateSnapshot(snapshot);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.valid) process.exitCode = 1;
}

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token?.startsWith("--")) continue;
    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    if (!rawKey) continue;
    const value = inlineValue ?? args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${rawKey}`);
    result[rawKey] = value;
    if (inlineValue === undefined) index += 1;
  }
  return result;
}

function numberArg(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`invalid positive integer ${value}`);
  return parsed;
}

function printUsage(): void {
  process.stderr.write(
    [
      "Usage:",
      "  npm run sync -- --repo https://github.com/owner/repo [--max-items 50] [--since ISO_DATE]",
      "  npm run process-run -- --run-id <knowledge-run-id>",
      "  node --import tsx src/cli.ts validate --snapshot data/snapshots/.../evidence-graph.json",
    ].join("\n") + "\n",
  );
}
