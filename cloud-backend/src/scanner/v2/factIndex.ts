import fs from "node:fs";
import path from "node:path";
import { buildBaseGraph } from "./baseGraph";
import { annotateArchitectureGraph } from "./architectureProjection";
import { buildAnalysisPlan } from "./analysisPackets";
import { fileEvidence } from "./evidence";
import { listSourceFiles, relativePath } from "./files";
import { factId, scopedId } from "./ids";
import { typescriptParser } from "./parsers/typescript";
import { genericResourceParser } from "./parsers/genericResources";
import { pythonPackageParser } from "./parsers/pythonPackages";
import {
  FACT_SCHEMA_VERSION,
  SCANNER_VERSION,
  type FactIndex,
  type NormalizedFact,
  type ParserAdapter,
  type ParserOutput,
  type ScanBundleV2,
} from "./contracts";
import { collectFacts, type Facts, type ModuleFact } from "../scan";

const LEGACY_EXTRACTOR = { name: "visionowl-module-discovery", version: "1.0.0" } as const;
const PARSERS: readonly ParserAdapter[] = [typescriptParser, pythonPackageParser, genericResourceParser];
const ROOT_SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".go", ".h", ".hpp", ".java", ".js", ".jsx",
  ".kt", ".kts", ".mjs", ".php", ".py", ".rb", ".rs", ".svelte", ".ts", ".tsx", ".vue",
]);

export interface ScanV2Options {
  projectId: string;
  repositoryId: string;
  commitSha: string;
  changedFiles?: string[];
}

function pythonDistributionName(root: string): string | null {
  try {
    const setup = fs.readFileSync(path.join(root, "setup.py"), "utf8");
    const name = setup.match(/\bname\s*=\s*["']([^"']+)["']/)?.[1];
    if (name) return name;
  } catch {
    // Try pyproject metadata below.
  }
  try {
    const pyproject = fs.readFileSync(path.join(root, "pyproject.toml"), "utf8");
    return pyproject.match(/(?:^|\n)\s*name\s*=\s*["']([^"']+)["']/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Workspace 清单通常只声明 packages/*，但仓库根目录仍可能包含网关、CLI 或启动器源码。
 * v1 为避免重复不会创建根模块；v2 在确实存在未归属源码时补一个根模块，防止入口丢失。
 */
function includeRootSourceModule(root: string, legacy: Facts): Facts {
  const existingRoot = legacy.modules.find((module) => module.modulePath === ".");
  if (existingRoot) {
    const distributionName = pythonDistributionName(root);
    if (!distributionName) return legacy;
    return {
      ...legacy,
      modules: legacy.modules.map((module) => module.modulePath === "."
        ? { ...module, name: distributionName, packageName: distributionName }
        : module),
    };
  }
  const modulePaths = legacy.modules
    .map((module) => module.modulePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, ""))
    .filter(Boolean);
  const unownedFiles = listSourceFiles(root, ROOT_SOURCE_EXTENSIONS)
    .map((file) => relativePath(root, file))
    .filter((file) => !modulePaths.some((modulePath) => file.startsWith(`${modulePath}/`)));
  if (unownedFiles.length === 0) return legacy;

  let packageName = path.basename(root);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { name?: string };
    packageName = manifest.name ?? packageName;
  } catch {
    // A source-only repository can still be modeled without a package manifest.
  }
  if (packageName === path.basename(root)) packageName = pythonDistributionName(root) ?? packageName;
  const rootModule: ModuleFact = {
    nodeId: `module:${path.basename(root)}`,
    name: packageName.replace(/^@[^/]+\//, ""),
    packageName,
    relPath: fs.existsSync(path.join(root, "package.json")) ? "package.json" : unownedFiles[0]!,
    modulePath: ".",
    domain: "root",
    description: "Repository root entrypoints and shared orchestration code",
    fileCount: unownedFiles.length,
  };
  return {
    ...legacy,
    modules: [rootModule, ...legacy.modules],
    fileCount: legacy.fileCount + unownedFiles.length,
  };
}

function moduleId(repositoryId: string, modulePath: string): string {
  return scopedId(repositoryId, "module", modulePath === "." ? "." : modulePath);
}

function legacyFactsToNormalized(
  root: string,
  legacy: Facts,
  repositoryId: string,
  commitSha: string,
): NormalizedFact[] {
  const normalized: NormalizedFact[] = [];
  const legacyToScoped = new Map(
    legacy.modules.map((module) => [module.nodeId, moduleId(repositoryId, module.modulePath)]),
  );
  const packageToScoped = new Map(
    legacy.modules
      .filter((module) => module.packageName)
      .map((module) => [module.packageName as string, moduleId(repositoryId, module.modulePath)]),
  );

  for (const module of legacy.modules) {
    const id = moduleId(repositoryId, module.modulePath);
    const evidence = fileEvidence(root, module.relPath, module.name);
    normalized.push({
      factId: factId(repositoryId, "module", id, undefined, undefined, evidence.file, 1),
      repositoryId,
      commitSha,
      language: "manifest",
      type: "module",
      subject: {
        id,
        name: module.name,
        kind: "module",
        path: module.modulePath,
      },
      evidence: [evidence],
      extractor: LEGACY_EXTRACTOR,
      certainty: "exact",
      attributes: {
        nodeKind: "module",
        domain: module.domain,
        packageName: module.packageName,
        description: module.description,
        fileCount: module.fileCount,
      },
    });
  }

  for (const submodule of legacy.submodules) {
    const parentId = legacyToScoped.get(submodule.parentNodeId);
    if (!parentId) continue;
    const id = scopedId(repositoryId, "submodule", submodule.modulePath);
    const evidence = fileEvidence(root, submodule.relPath, submodule.name);
    normalized.push({
      factId: factId(repositoryId, "module", parentId, "contains", id, evidence.file, 1),
      repositoryId,
      commitSha,
      language: "manifest",
      type: "module",
      subject: { id: parentId, name: submodule.domain, kind: "module" },
      relation: "contains",
      object: {
        id,
        name: submodule.name,
        kind: "submodule",
        moduleId: parentId,
        path: submodule.modulePath,
      },
      evidence: [evidence],
      extractor: LEGACY_EXTRACTOR,
      certainty: "exact",
      attributes: {
        nodeKind: "submodule",
        domain: submodule.domain,
        description: submodule.description,
        fileCount: submodule.fileCount,
      },
    });
  }

  for (const imported of legacy.imports) {
    const sourceId = legacyToScoped.get(imported.fromModule);
    const targetId = packageToScoped.get(imported.toSpecifier);
    if (!sourceId || !targetId || sourceId === targetId) continue;
    const evidence = fileEvidence(root, imported.file, imported.toSpecifier);
    evidence.startLine = imported.line;
    evidence.endLine = imported.line;
    normalized.push({
      factId: factId(repositoryId, "import", sourceId, "import", targetId, imported.file, imported.line),
      repositoryId,
      commitSha,
      language: "generic",
      type: "import",
      subject: { id: sourceId, name: sourceId, kind: "module" },
      relation: "import",
      object: { id: targetId, name: imported.toSpecifier, kind: "module" },
      evidence: [evidence],
      extractor: LEGACY_EXTRACTOR,
      certainty: "resolved",
      attributes: { specifier: imported.toSpecifier },
    });
  }

  for (const reference of legacy.infraRefs) {
    const sourceId = legacyToScoped.get(reference.fromModule);
    if (!sourceId) continue;
    const infraKind = reference.nodeId.includes("redis") ? "redis" : reference.nodeId.includes("mq") ? "mq" : "db";
    const targetId = scopedId(repositoryId, infraKind, reference.nodeId.replace(/^infra:/, ""));
    const evidence = fileEvidence(root, reference.file, reference.nodeId);
    evidence.startLine = reference.line;
    evidence.endLine = reference.line;
    normalized.push({
      factId: factId(repositoryId, infraKind, sourceId, infraKind === "redis" ? "read" : infraKind === "mq" ? "publish" : "write", targetId, reference.file, reference.line),
      repositoryId,
      commitSha,
      language: "generic",
      type: infraKind,
      subject: { id: sourceId, name: sourceId, kind: "module" },
      relation: infraKind === "redis" ? "read" : infraKind === "mq" ? "publish" : "write",
      object: { id: targetId, name: reference.nodeId.replace(/^infra:/, ""), kind: infraKind },
      evidence: [evidence],
      extractor: LEGACY_EXTRACTOR,
      certainty: "configured",
      attributes: { target: reference.nodeId },
    });
  }

  return normalized;
}

function emptyParserOutput(parser: ParserAdapter): ParserOutput {
  return {
    parserName: parser.name,
    parserVersion: parser.version,
    facts: [],
    definitions: [],
    references: [],
    interfaces: [],
    resources: [],
    diagnostics: [],
  };
}

function countBy<T>(values: T[], key: (value: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[key(value)] = (counts[key(value)] ?? 0) + 1;
  return counts;
}

export function scanRepositoryV2(root: string, options: ScanV2Options): ScanBundleV2 {
  const generatedAt = new Date().toISOString();
  const legacyFacts = includeRootSourceModule(root, collectFacts(root));
  const parserInput = {
    root,
    repositoryId: options.repositoryId,
    commitSha: options.commitSha,
    legacyFacts,
  };
  const parserOutputs = PARSERS.map((parser) =>
    parser.detect(parserInput) ? parser.parseFiles(parserInput) : emptyParserOutput(parser),
  );
  const rawFacts = [
    ...legacyFactsToNormalized(root, legacyFacts, options.repositoryId, options.commitSha),
    ...parserOutputs.flatMap((output) => output.facts),
  ];
  const facts = [...new Map(rawFacts.map((fact) => [fact.factId, fact])).values()].sort((left, right) =>
    left.factId.localeCompare(right.factId),
  );
  const parserVersions = Object.fromEntries([
    [LEGACY_EXTRACTOR.name, LEGACY_EXTRACTOR.version],
    ...parserOutputs.map((output) => [output.parserName, output.parserVersion]),
  ]);
  const factIndex: FactIndex = {
    schemaVersion: FACT_SCHEMA_VERSION,
    scannerVersion: SCANNER_VERSION,
    repositoryId: options.repositoryId,
    commitSha: options.commitSha,
    generatedAt,
    parserVersions,
    facts,
    stats: {
      factCount: facts.length,
      byType: countBy(facts, (fact) => fact.type),
      byCertainty: countBy(facts, (fact) => fact.certainty),
    },
  };
  const symbolIndex = {
    schemaVersion: FACT_SCHEMA_VERSION,
    repositoryId: options.repositoryId,
    commitSha: options.commitSha,
    generatedAt,
    definitions: parserOutputs.flatMap((output) => output.definitions),
    references: parserOutputs.flatMap((output) => output.references),
  };
  const interfaceCatalog = {
    schemaVersion: FACT_SCHEMA_VERSION,
    repositoryId: options.repositoryId,
    commitSha: options.commitSha,
    generatedAt,
    interfaces: parserOutputs.flatMap((output) => output.interfaces),
  };
  const resourceCatalog = {
    schemaVersion: FACT_SCHEMA_VERSION,
    repositoryId: options.repositoryId,
    commitSha: options.commitSha,
    generatedAt,
    resources: parserOutputs.flatMap((output) => output.resources),
  };
  const diagnostics = {
    schemaVersion: FACT_SCHEMA_VERSION,
    repositoryId: options.repositoryId,
    commitSha: options.commitSha,
    generatedAt,
    diagnostics: parserOutputs.flatMap((output) => output.diagnostics),
  };
  const baseGraph = annotateArchitectureGraph(
    buildBaseGraph(factIndex, options.projectId),
    factIndex,
  );
  const analysisPlan = buildAnalysisPlan({
    projectId: options.projectId,
    factIndex,
    symbolIndex,
    interfaceCatalog,
    resourceCatalog,
    diagnostics,
    baseGraph,
    changedFiles: options.changedFiles,
  });

  return {
    legacyFacts,
    factIndex,
    symbolIndex,
    interfaceCatalog,
    resourceCatalog,
    diagnostics,
    baseGraph,
    analysisPlan,
  };
}
