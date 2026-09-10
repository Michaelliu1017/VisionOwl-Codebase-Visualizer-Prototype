/**
 * 确定性扫描器（spec §4.3 阶段一，零 credit）
 *
 * 输入：仓库工作区目录。输出：facts.json（结构事实）+ graph.json 骨架。
 * 铁律：**只产出可复现的结构事实**——不猜测、不调用 LLM。
 * 语义增强（职责摘要/业务流程/推断关系）由阶段二 Agent 在骨架上填充，不得改动骨架。
 */
import fs from "node:fs";
import path from "node:path";
import type { Evidence, GraphDocument, GraphEdge, GraphNode, EdgeType } from "../types";

const CODE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
  ".py", ".java", ".kt", ".kts", ".go", ".rs", ".cs", ".rb", ".php",
  ".html", ".css",
]);
const MANIFEST_NAMES = [
  "package.json", "pyproject.toml", "requirements.txt", "setup.py", "Pipfile",
  "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts",
];
const SKIP_DIR = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "__snapshots__",
  // Python 生态：虚拟环境与第三方包不属于项目代码（实测某仓库 2277 个 .py 中
  // 仅 3 个是业务代码，其余全在 venv/site-packages）
  "venv",
  ".venv",
  "env",
  "site-packages",
  "__pycache__",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ipynb_checkpoints",
  "egg-info",
]);

/** 基础设施识别表：包名 → 节点 + 关系语义 */
const INFRA_RULES: Array<{
  match: RegExp;
  nodeId: string;
  name: string;
  kind: "infra.db" | "infra.redis" | "infra.mq";
  edge: EdgeType;
  summary: string;
}> = [
  { match: /^(pg|pg-pool|postgres|postgres\.js|node-postgres|sequelize|typeorm|prisma|knex|mysql2?)$/, nodeId: "infra:postgres", name: "PostgreSQL", kind: "infra.db", edge: "write", summary: "主数据库" },
  { match: /^(ioredis|redis|@redis\/client)$/, nodeId: "infra:redis", name: "Redis", kind: "infra.redis", edge: "read", summary: "缓存 / 会话存储" },
  { match: /^(amqplib|kafkajs|nats|mqtt|rabbit\.js|bullmq|@aws-sdk\/client-sqs)$/, nodeId: "infra:mq", name: "Message Queue", kind: "infra.mq", edge: "publish", summary: "消息队列（事件总线后端）" },
];

export interface ModuleFact {
  nodeId: string;
  name: string;
  packageName: string | null;
  relPath: string;
  modulePath: string;
  domain: string;
  description: string | null;
  fileCount: number;
}

/** 模块内部的稳定代码分区。默认不进入总览，选中父模块时按需展开。 */
export interface SubmoduleFact {
  nodeId: string;
  parentNodeId: string;
  name: string;
  relPath: string;
  modulePath: string;
  domain: string;
  description: string;
  fileCount: number;
}

export interface ImportFact {
  fromModule: string;
  toSpecifier: string;
  file: string;
  line: number;
}

export interface Facts {
  schemaVersion: "1.0";
  generatedAt: string;
  root: string;
  modules: ModuleFact[];
  submodules: SubmoduleFact[];
  imports: ImportFact[];
  infraRefs: Array<{ fromModule: string; nodeId: string; file: string; line: number }>;
  fileCount: number;
}

// ── 工具 ──────────────────────────────────────────────────────────────
function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function walk(dir: string, root: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR.has(entry.name)) continue;
      walk(abs, root, out);
    } else if (CODE_EXT.has(path.extname(entry.name))) {
      out.push(path.relative(root, abs).split(path.sep).join("/"));
    }
  }
  return out;
}

function hasCode(dir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIR.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isFile() && CODE_EXT.has(path.extname(entry.name))) return true;
    if (entry.isDirectory() && hasCode(abs)) return true;
  }
  return false;
}

function findManifest(dir: string): string | null {
  return MANIFEST_NAMES.find((name) => fs.existsSync(path.join(dir, name))) ?? null;
}

function discoverManifestDirs(root: string, dir = root, depth = 0, out = new Set<string>()): Set<string> {
  if (depth > 4) return out;
  if (dir !== root && findManifest(dir)) {
    out.add(path.relative(root, dir).split(path.sep).join("/"));
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIR.has(entry.name)) continue;
    discoverManifestDirs(root, path.join(dir, entry.name), depth + 1, out);
  }
  return out;
}

/** 普通仓库兜底：按 manifest 与前两层代码目录建立稳定模块，不要求 monorepo workspaces。 */
function discoverGenericModuleDirs(root: string): string[] {
  const candidates = discoverManifestDirs(root);
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const rootHasCodeFile = entries.some(
    (entry) => entry.isFile() && CODE_EXT.has(path.extname(entry.name)),
  );
  if (rootHasCodeFile) candidates.add(".");

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIR.has(entry.name)) continue;
    const topAbs = path.join(root, entry.name);
    const children = fs
      .readdirSync(topAbs, { withFileTypes: true })
      .filter((child) => child.isDirectory() && !child.name.startsWith(".") && !SKIP_DIR.has(child.name))
      .filter((child) => hasCode(path.join(topAbs, child.name)));
    if (children.length > 0) {
      for (const child of children) candidates.add(`${entry.name}/${child.name}`);
    } else if (hasCode(topAbs)) {
      candidates.add(entry.name);
    }
  }

  const sorted = [...candidates].sort();
  return sorted.filter(
    // A manifest at a repository/service root owns its descendants. Keeping the
    // deepest directory here turned `agent-rest` into the misleading `src`
    // module and `GoProbe` into `cmsprobe` in multi-repository workspaces.
    (candidate) => !sorted.some((other) => other !== candidate && candidate.startsWith(`${other}/`)),
  );
}

function expandWorkspaceGlobs(root: string, patterns: string[]): string[] {
  const dirs: string[] = [];
  for (const pattern of patterns) {
    const clean = pattern.replace(/\/\*\*$/, "/*");
    if (clean.endsWith("/*")) {
      const base = path.join(root, clean.slice(0, -2));
      if (!fs.existsSync(base)) continue;
      for (const entry of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory() && fs.existsSync(path.join(base, entry.name, "package.json"))) {
          dirs.push(path.relative(root, path.join(base, entry.name)).split(path.sep).join("/"));
        }
      }
    } else if (fs.existsSync(path.join(root, clean, "package.json"))) {
      dirs.push(clean);
    }
  }
  return dirs;
}

const IMPORT_RE =
  /(?:import\s+(?:[\w*{}\n\r\t, ]+\s+from\s+)?|export\s+(?:[\w*{}\n\r\t, ]+\s+from\s+)|require\s*\(\s*|import\s*\(\s*)["']([^"']+)["']/g;

function extractImports(content: string): Array<{ specifier: string; line: number }> {
  const out: Array<{ specifier: string; line: number }> = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(line)) !== null) {
      const spec = m[1];
      if (spec) out.push({ specifier: spec, line: i + 1 });
    }
  }
  return out;
}

/** 取包名根（@scope/name 或 name），去掉子路径 */
function packageRoot(specifier: string): string {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return specifier;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

const SOURCE_ROOTS = ["src", "app", "internal", "pkg", "lib"];
const MAX_SUBMODULES_PER_MODULE = 8;

function isTestLike(file: string): boolean {
  return /(^|\/)(__tests__|fixtures?|test|tests)(\/|$)|\.(spec|test)\.[^.]+$/i.test(file);
}

/**
 * 从模块内部抽取一层“代码分区”，而不是把每个文件或函数都铺到总览里。
 * 例如 cloud-backend/src 下的 api、services、infra、worker 会成为次级节点；
 * 对没有子目录的小模块，则取少量直接入口文件作为兜底。
 */
function discoverSubmodules(root: string, mod: ModuleFact): SubmoduleFact[] {
  const moduleAbs = path.join(root, mod.modulePath);
  // modulePath 本身已经是 src/app/lib 时不再错误下钻到 src/lib。
  const moduleBase = path.basename(moduleAbs);
  const sourceRoot = SOURCE_ROOTS.includes(moduleBase)
    ? moduleAbs
    : SOURCE_ROOTS
        .map((name) => path.join(moduleAbs, name))
        .find((candidate) => fs.existsSync(candidate) && hasCode(candidate)) ?? moduleAbs;

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(sourceRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIP_DIR.has(entry.name))
    .map((entry) => ({ entry, abs: path.join(sourceRoot, entry.name) }))
    .filter(({ abs }) => hasCode(abs))
    .map(({ entry, abs }) => {
      const files = walk(abs, root).filter((file) => !isTestLike(file));
      return { name: entry.name, abs, files };
    })
    .filter((item) => item.files.length > 0)
    .sort((a, b) => b.files.length - a.files.length || a.name.localeCompare(b.name));

  const candidates = directories.length > 0
    ? directories.slice(0, MAX_SUBMODULES_PER_MODULE).map((item) => ({
        name: item.name,
        path: path.relative(root, item.abs).split(path.sep).join("/"),
        evidence: item.files[0]!,
        fileCount: item.files.length,
        description: `${mod.name} 内部的 ${item.name} 代码分区，包含 ${item.files.length} 个源文件`,
      }))
    : entries
        .filter((entry) => entry.isFile() && CODE_EXT.has(path.extname(entry.name)))
        .map((entry) => path.join(sourceRoot, entry.name))
        .map((abs) => path.relative(root, abs).split(path.sep).join("/"))
        .filter((file) => !isTestLike(file))
        .sort()
        .slice(0, 5)
        .map((file) => ({
          name: path.basename(file, path.extname(file)),
          path: file,
          evidence: file,
          fileCount: 1,
          description: `${mod.name} 的内部实现入口`,
        }));

  return candidates.map((candidate) => ({
    nodeId: `submodule:${candidate.path}`,
    parentNodeId: mod.nodeId,
    name: candidate.name,
    relPath: candidate.evidence,
    modulePath: candidate.path,
    domain: mod.domain,
    description: candidate.description,
    fileCount: candidate.fileCount,
  }));
}

// ── 阶段一主流程 ───────────────────────────────────────────────────────
export function collectFacts(root: string): Facts {
  const rootPkg = readJson<{ workspaces?: string[] | { packages?: string[] }; name?: string }>(
    path.join(root, "package.json"),
  );
  const wsPatterns = Array.isArray(rootPkg?.workspaces)
    ? rootPkg!.workspaces
    : (rootPkg?.workspaces as { packages?: string[] } | undefined)?.packages ?? [];

  let moduleDirs = expandWorkspaceGlobs(root, wsPatterns.length > 0 ? wsPatterns : []);
  if (moduleDirs.length === 0) {
    // 无 workspaces 声明时的兜底约定
    moduleDirs = expandWorkspaceGlobs(root, ["apps/*", "modules/*", "packages/*", "services/*", "libs/*"]);
  }
  if (moduleDirs.length === 0) {
    moduleDirs = discoverGenericModuleDirs(root);
  }
  if (moduleDirs.length === 0 && fs.existsSync(path.join(root, "package.json"))) {
    moduleDirs = ["."];
  }

  const modules: ModuleFact[] = [];
  const pkgNameToNode = new Map<string, string>();
  const imports: ImportFact[] = [];
  const infraRefs: Facts["infraRefs"] = [];
  let fileCount = 0;

  for (const relDir of moduleDirs) {
    const abs = path.join(root, relDir);
    const pkg = readJson<{ name?: string; description?: string; dependencies?: Record<string, string> }>(
      path.join(abs, "package.json"),
    );
    const manifest = findManifest(abs);
    const files = walk(abs, root);
    const nodeId = relDir === "." ? `module:${path.basename(root)}` : `module:${relDir}`;
    const domain = relDir === "." ? "root" : (relDir.split("/")[0] ?? "root");
    fileCount += files.length;
    modules.push({
      nodeId,
      name: pkg?.name ? pkg.name.replace(/^@[^/]+\//, "") : path.basename(relDir === "." ? root : relDir),
      packageName: pkg?.name ?? null,
      relPath: manifest
        ? (relDir === "." ? manifest : `${relDir}/${manifest}`)
        : files[0] ?? relDir,
      modulePath: relDir,
      domain,
      description: pkg?.description ?? null,
      fileCount: files.length,
    });
    if (pkg?.name) pkgNameToNode.set(pkg.name, nodeId);
  }

  // 第二遍：解析 import（需要先建立 pkgName → nodeId 映射）
  for (const mod of modules) {
    const abs = path.join(root, mod.modulePath);
    for (const file of walk(abs, root)) {
      let content: string;
      try {
        content = fs.readFileSync(path.join(root, file), "utf8");
      } catch {
        continue;
      }
      for (const { specifier, line } of extractImports(content)) {
        const pkgRootName = packageRoot(specifier);
        if (specifier.startsWith(".")) continue; // 模块内相对引用不构成模块间关系

        if (pkgNameToNode.has(pkgRootName)) {
          imports.push({ fromModule: mod.nodeId, toSpecifier: pkgRootName, file, line });
          continue;
        }
        const infra = INFRA_RULES.find((r) => r.match.test(pkgRootName));
        if (infra) infraRefs.push({ fromModule: mod.nodeId, nodeId: infra.nodeId, file, line });
      }
    }
  }

  const submodules = modules
    .flatMap((mod) => discoverSubmodules(root, mod))
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId));

  return {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    root,
    modules: modules.sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
    submodules,
    imports: imports.sort((a, b) => `${a.fromModule}${a.toSpecifier}${a.file}${a.line}`.localeCompare(`${b.fromModule}${b.toSpecifier}${b.file}${b.line}`)),
    infraRefs,
    fileCount,
  };
}

/** 关系类型判定：apps→modules 视为调用，其余为依赖；事件/缓存/库按包名语义细分 */
function classifyEdge(fromDomain: string, toNodeId: string, toName: string): EdgeType {
  if (/event-bus|eventbus|events?$/.test(toName)) return "publish";
  if (fromDomain === "apps" && toNodeId.startsWith("module:modules/")) return "call";
  return "dependency";
}

export function buildGraphSkeleton(facts: Facts, projectId: string, commitSha: string): GraphDocument {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const byId = new Map<string, ModuleFact>();

  for (const mod of facts.modules) {
    byId.set(mod.nodeId, mod);
    const evidence: Evidence[] = [{ file: mod.relPath, startLine: 1 }];
    nodes.push({
      id: mod.nodeId,
      name: mod.name,
      kind: "module",
      path: mod.modulePath,
      domain: mod.domain,
      summary: mod.description?.trim() || `${mod.domain} 代码域中的 ${mod.name} 模块，包含 ${mod.fileCount} 个源文件`,
      evidence,
      inferred: false,
    });
  }

  for (const submodule of facts.submodules) {
    nodes.push({
      id: submodule.nodeId,
      name: submodule.name,
      kind: "submodule",
      path: submodule.modulePath,
      domain: submodule.domain,
      parentId: submodule.parentNodeId,
      summary: submodule.description,
      evidence: [{ file: submodule.relPath, startLine: 1 }],
      inferred: false,
    });
  }

  // 模块间依赖（聚合同一对模块的多次 import，保留首个证据 + 计数）
  const pkgToNode = new Map<string, string>();
  for (const mod of facts.modules) if (mod.packageName) pkgToNode.set(mod.packageName, mod.nodeId);

  const seen = new Map<string, GraphEdge>();
  for (const submodule of facts.submodules) {
    const id = `e:${submodule.parentNodeId}->${submodule.nodeId}:contains`;
    seen.set(id, {
      id,
      source: submodule.parentNodeId,
      target: submodule.nodeId,
      type: "contains",
      inferred: false,
      evidence: [{ file: submodule.relPath, startLine: 1 }],
    });
  }
  for (const imp of facts.imports) {
    const target = pkgToNode.get(imp.toSpecifier);
    if (!target || target === imp.fromModule) continue;
    const from = byId.get(imp.fromModule);
    const to = byId.get(target);
    if (!from || !to) continue;
    const type = classifyEdge(from.domain, target, to.name);
    const id = `e:${imp.fromModule}->${target}:${type}`;
    const existing = seen.get(id);
    if (existing) {
      if ((existing.evidence?.length ?? 0) < 3) {
        existing.evidence = [...(existing.evidence ?? []), { file: imp.file, startLine: imp.line }];
      }
      continue;
    }
    seen.set(id, {
      id,
      source: imp.fromModule,
      target,
      type,
      inferred: false,
      evidence: [{ file: imp.file, startLine: imp.line }],
    });
  }

  // 基础设施节点与关系
  const infraNeeded = new Map<string, (typeof INFRA_RULES)[number]>();
  for (const ref of facts.infraRefs) {
    const rule = INFRA_RULES.find((r) => r.nodeId === ref.nodeId);
    if (rule) infraNeeded.set(rule.nodeId, rule);
  }
  for (const rule of infraNeeded.values()) {
    nodes.push({
      id: rule.nodeId,
      name: rule.name,
      kind: rule.kind,
      path: null,
      domain: "infra",
      summary: rule.summary,
      evidence: [],
      inferred: false,
    });
  }
  for (const ref of facts.infraRefs) {
    const rule = INFRA_RULES.find((r) => r.nodeId === ref.nodeId);
    if (!rule) continue;
    const id = `e:${ref.fromModule}->${rule.nodeId}:${rule.edge}`;
    const existing = seen.get(id);
    if (existing) continue;
    seen.set(id, {
      id,
      source: ref.fromModule,
      target: rule.nodeId,
      type: rule.edge,
      inferred: false,
      evidence: [{ file: ref.file, startLine: ref.line }],
    });
  }

  edges.push(...[...seen.values()].sort((a, b) => a.id.localeCompare(b.id)));

  return {
    schemaVersion: "1.0",
    projectId,
    commitSha,
    generatedAt: new Date().toISOString(),
    nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)),
    edges,
    views: [
      {
        id: "overview",
        name: "总体架构",
        // 次级节点存在于图谱事实中，但总览默认折叠；前端选中父模块时再展开。
        nodeIds: nodes.filter((n) => n.kind !== "submodule").map((n) => n.id),
        edgeIds: edges.map((e) => e.id),
      },
    ],
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      inferredCount: 0,
    },
  };
}

/** 变更文件 → 受影响模块 + 一层邻接闭包（增量分析用，spec §7.2-2） */
export function computeImpact(
  graph: GraphDocument,
  changedFiles: string[],
): { affectedNodeIds: string[]; globalStructureChanged: boolean } {
  const direct = new Set<string>();
  for (const file of changedFiles) {
    for (const node of graph.nodes) {
      const p = node.path;
      if (p && (file === p || file.startsWith(`${p}/`))) direct.add(node.id);
    }
  }
  const closure = new Set(direct);
  for (const e of graph.edges) {
    if (direct.has(e.source)) closure.add(e.target);
    if (direct.has(e.target)) closure.add(e.source);
  }
  // 根级配置/依赖清单变化视为全局结构变化
  const globalStructureChanged = changedFiles.some((f) =>
    /^(package\.json|package-lock\.json|pnpm-lock\.yaml|tsconfig\.json|docker-compose\.ya?ml|compose\.ya?ml)$/.test(f),
  ) || direct.size === 0;

  return { affectedNodeIds: [...closure].sort(), globalStructureChanged };
}
