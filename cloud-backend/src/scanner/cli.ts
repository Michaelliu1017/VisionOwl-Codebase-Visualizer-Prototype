#!/usr/bin/env node
/**
 * 扫描器 CLI —— Runner 容器内阶段一入口，也可本地直接跑：
 *   npm run scan -- --repo ../test --out /tmp/out --project-id demo --sha abc1234
 *
 * 产出：Fact Index v2 六类产物、graph.base.json、graph.json、质量报告和 impact.json。
 * facts.json 继续保留 v1 兼容副本，便于灰度回退。
 */
import fs from "node:fs";
import path from "node:path";
import { computeImpact } from "./scan";
import { scanRepositoryV2 } from "./v2/factIndex";
import { postprocessGraph } from "./v2/postprocess";
import { compareScannerVersions } from "./v2/baseline";
import { emptyGraphPatch } from "../schemas/patchValidator";
import { validateGraph } from "../schemas/graphValidator";

interface Args {
  repo: string;
  out: string;
  projectId: string;
  repositoryId: string;
  sha: string;
  base?: string;
  changedFiles?: string[];
}

function parseArgs(argv: string[]): Args {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq > 0) map.set(token.slice(2, eq), token.slice(eq + 1));
    else map.set(token.slice(2), argv[++i] ?? "");
  }
  const repo = map.get("repo") ?? process.env.REPO_DIR ?? "/workspace/repo";
  const out = map.get("out") ?? process.env.OUT_DIR ?? "/workspace/out";
  const changed = map.get("changed-files");
  return {
    repo: path.resolve(repo),
    out: path.resolve(out),
    projectId: map.get("project-id") ?? process.env.PROJECT_ID ?? "local",
    repositoryId: map.get("repository-id") ?? process.env.REPOSITORY_ID ?? map.get("project-id") ?? process.env.PROJECT_ID ?? "local",
    sha: map.get("sha") ?? process.env.COMMIT_SHA ?? "0000000",
    base: map.get("base") ?? process.env.BASE_SHA ?? undefined,
    changedFiles: changed ? changed.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.repo)) {
    console.error(`[scanner] 仓库目录不存在：${args.repo}`);
    process.exit(2);
  }
  fs.mkdirSync(args.out, { recursive: true });

  const t0 = Date.now();
  const bundle = scanRepositoryV2(args.repo, {
    projectId: args.projectId,
    repositoryId: args.repositoryId,
    commitSha: args.sha,
    changedFiles: args.changedFiles,
  });
  const patch = emptyGraphPatch(bundle.baseGraph, args.repositoryId);
  const processed = postprocessGraph({
    baseGraph: bundle.baseGraph,
    factIndex: bundle.factIndex,
    symbolIndex: bundle.symbolIndex,
    diagnostics: bundle.diagnostics,
    patch,
    fileExists: (relativePath) => fs.existsSync(path.join(args.repo, relativePath)),
  });
  const graph = processed.graph;
  const comparison = compareScannerVersions(args.projectId, bundle);

  fs.writeFileSync(path.join(args.out, "facts.json"), JSON.stringify(bundle.legacyFacts, null, 2));
  fs.writeFileSync(path.join(args.out, "facts.v2.json"), JSON.stringify(bundle.factIndex, null, 2));
  fs.writeFileSync(path.join(args.out, "symbol-index.json"), JSON.stringify(bundle.symbolIndex, null, 2));
  fs.writeFileSync(path.join(args.out, "interface-catalog.json"), JSON.stringify(bundle.interfaceCatalog, null, 2));
  fs.writeFileSync(path.join(args.out, "resource-catalog.json"), JSON.stringify(bundle.resourceCatalog, null, 2));
  fs.writeFileSync(path.join(args.out, "diagnostics.json"), JSON.stringify(bundle.diagnostics, null, 2));
  fs.writeFileSync(path.join(args.out, "analysis-packets.json"), JSON.stringify(bundle.analysisPlan, null, 2));
  fs.writeFileSync(path.join(args.out, "scanner-comparison.json"), JSON.stringify(comparison, null, 2));
  fs.writeFileSync(path.join(args.out, "graph.base.json"), JSON.stringify(bundle.baseGraph, null, 2));
  fs.writeFileSync(path.join(args.out, "graph-patch.json"), JSON.stringify(patch, null, 2));
  fs.writeFileSync(path.join(args.out, "patch-validation.json"), JSON.stringify(processed.validation, null, 2));
  fs.writeFileSync(path.join(args.out, "accepted-patches.json"), JSON.stringify(processed.validation.accepted, null, 2));
  fs.writeFileSync(path.join(args.out, "rejected-patches.json"), JSON.stringify(processed.validation.rejected, null, 2));
  fs.writeFileSync(path.join(args.out, "conflicting-patches.json"), JSON.stringify(processed.validation.conflicts, null, 2));
  fs.writeFileSync(path.join(args.out, "quality-report.json"), JSON.stringify(processed.quality, null, 2));
  fs.writeFileSync(path.join(args.out, "graph.json"), JSON.stringify(graph, null, 2));
  fs.writeFileSync(path.join(args.out, "scanner-manifest.json"), JSON.stringify({
    schemaVersion: "1.0",
    scannerVersion: bundle.factIndex.scannerVersion,
    factSchemaVersion: bundle.factIndex.schemaVersion,
    repositoryId: args.repositoryId,
    commitSha: args.sha,
    generatedAt: bundle.factIndex.generatedAt,
    parserVersions: bundle.factIndex.parserVersions,
  }, null, 2));

  if (args.changedFiles && args.changedFiles.length > 0) {
    const impact = computeImpact(graph, args.changedFiles);
    fs.writeFileSync(
      path.join(args.out, "impact.json"),
      JSON.stringify(
        {
          commitSha: args.sha,
          baseCommitSha: args.base ?? null,
          changedFiles: args.changedFiles,
          affectedNodeIds: impact.affectedNodeIds,
          globalStructureChanged: impact.globalStructureChanged,
        },
        null,
        2,
      ),
    );
  }

  const result = validateGraph(graph, {
    fileExists: (rel) => fs.existsSync(path.join(args.repo, rel)),
  });

  console.log(
    `[scanner] ${bundle.legacyFacts.modules.length} 模块 + ${bundle.legacyFacts.submodules.length} 次级模块 / ` +
      `${bundle.legacyFacts.fileCount} 文件 / ${bundle.factIndex.stats.factCount} facts → ` +
      `${graph.nodes.length} 节点 / ${graph.edges.length} 边（${Date.now() - t0}ms）`,
  );
  if (!result.ok) {
    console.error("[scanner] 骨架校验失败：");
    for (const e of result.errors) console.error(`  - ${e}`);
    process.exit(3);
  }
  if (!processed.quality.publishable) {
    console.error("[scanner] 语义质量门禁拒绝发布：");
    for (const issue of processed.quality.issues.slice(0, 10)) console.error(`  - ${issue.message}`);
    process.exit(4);
  }
  console.log(`[scanner] Schema 校验通过，质量门禁=${processed.quality.disposition}`);
}

main();
