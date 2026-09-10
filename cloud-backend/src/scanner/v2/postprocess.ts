import fs from "node:fs";
import path from "node:path";
import type { GraphDocument } from "../../types";
import type { DiagnosticsDocument, FactIndex, SymbolIndex } from "./contracts";
import { annotateArchitectureGraph, buildArchitecturePresentation } from "./architectureProjection";
import { evaluateSemanticQuality, type SemanticQualityReport } from "../../schemas/semanticQuality";
import { mergeAcceptedPatches } from "../../schemas/patchMerger";
import {
  emptyGraphPatch,
  normalizeGraphPatchAliases,
  validateGraphPatch,
  type GraphPatchDocument,
  type PatchValidationResult,
} from "../../schemas/patchValidator";

export interface PostprocessInput {
  baseGraph: GraphDocument;
  factIndex: FactIndex;
  symbolIndex: SymbolIndex;
  diagnostics: DiagnosticsDocument;
  patch?: GraphPatchDocument | null;
  fileExists?: (relativePath: string) => boolean;
}

export interface PostprocessResult {
  graph: GraphDocument;
  patch: GraphPatchDocument;
  validation: PatchValidationResult;
  quality: SemanticQualityReport;
}

export function postprocessGraph(input: PostprocessInput): PostprocessResult {
  const patch = normalizeGraphPatchAliases(
    input.patch ?? emptyGraphPatch(input.baseGraph, input.factIndex.repositoryId),
  ) as GraphPatchDocument;
  const validation = validateGraphPatch(patch, {
    baseGraph: input.baseGraph,
    factIndex: input.factIndex,
    symbolIndex: input.symbolIndex,
    fileExists: input.fileExists,
  });
  const annotatedGraph = annotateArchitectureGraph(
    mergeAcceptedPatches(input.baseGraph, validation.accepted),
    input.factIndex,
  );
  const quality = evaluateSemanticQuality(annotatedGraph, input.factIndex, input.diagnostics, {
    fileExists: input.fileExists,
  });
  const graph = buildArchitecturePresentation(annotatedGraph, input.factIndex);
  return { graph, patch, validation, quality };
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function main(): void {
  const args = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 1) {
    const key = process.argv[index];
    if (!key?.startsWith("--")) continue;
    args.set(key.slice(2), process.argv[index + 1] ?? "");
    index += 1;
  }
  const out = path.resolve(args.get("out") ?? process.env.OUT_DIR ?? "/workspace/out");
  const repo = path.resolve(args.get("repo") ?? process.env.REPO_DIR ?? "/workspace/repo");
  const patchFile = path.join(out, "graph-patch.json");
  const rawPatch = fs.existsSync(patchFile) ? readJson<unknown>(patchFile) : null;
  const normalizedPatch = rawPatch ? normalizeGraphPatchAliases(rawPatch) : null;
  if (rawPatch && JSON.stringify(rawPatch) !== JSON.stringify(normalizedPatch)) {
    fs.writeFileSync(path.join(out, "graph-patch.agent-raw.json"), JSON.stringify(rawPatch, null, 2));
    fs.writeFileSync(patchFile, JSON.stringify(normalizedPatch, null, 2));
  }
  const result = postprocessGraph({
    baseGraph: readJson<GraphDocument>(path.join(out, "graph.base.json")),
    factIndex: readJson<FactIndex>(path.join(out, "facts.v2.json")),
    symbolIndex: readJson<SymbolIndex>(path.join(out, "symbol-index.json")),
    diagnostics: readJson<DiagnosticsDocument>(path.join(out, "diagnostics.json")),
    patch: normalizedPatch as GraphPatchDocument | null,
    fileExists: (relativePath) => fs.existsSync(path.join(repo, relativePath)),
  });
  fs.writeFileSync(path.join(out, "graph.json"), JSON.stringify(result.graph, null, 2));
  fs.writeFileSync(path.join(out, "patch-validation.json"), JSON.stringify(result.validation, null, 2));
  fs.writeFileSync(path.join(out, "accepted-patches.json"), JSON.stringify(result.validation.accepted, null, 2));
  fs.writeFileSync(path.join(out, "rejected-patches.json"), JSON.stringify(result.validation.rejected, null, 2));
  fs.writeFileSync(path.join(out, "conflicting-patches.json"), JSON.stringify(result.validation.conflicts, null, 2));
  fs.writeFileSync(path.join(out, "quality-report.json"), JSON.stringify(result.quality, null, 2));
  if (!result.validation.ok) {
    console.error(`[postprocess] Patch 文档无效：${result.validation.documentErrors.join("; ")}`);
    process.exit(4);
  }
  if (!result.quality.publishable) {
    console.error(`[postprocess] 质量门禁拒绝发布：${result.quality.issues.slice(0, 5).map((issue) => issue.message).join("; ")}`);
    process.exit(5);
  }
  console.log(
    `[postprocess] accepted=${result.validation.accepted.length} rejected=${result.validation.rejected.length} quality=${result.quality.disposition}`,
  );
}

if (require.main === module) main();
