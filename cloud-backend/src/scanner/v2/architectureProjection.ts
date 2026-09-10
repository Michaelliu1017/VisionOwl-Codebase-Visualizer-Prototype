import type { Evidence, GraphDocument, GraphEdge, GraphNode, GraphView } from "../../types";
import { computeStats } from "../../schemas/graphValidator";
import { orderGraphViews } from "../../schemas/viewOrder";
import type { FactIndex, NormalizedFact } from "./contracts";
import { stableHash } from "./ids";

type Architecture = NonNullable<GraphNode["architecture"]>;
type ArchitectureRole = Architecture["role"];
type DisplayGroup = NonNullable<Architecture["displayGroup"]>;

interface ModuleMetrics {
  node: GraphNode;
  role: ArchitectureRole;
  score: number;
  fileCount: number;
  degree: number;
  entryCount: number;
  resourceCount: number;
  declared: boolean;
  penalized: boolean;
}

const MAX_OVERVIEW_MODULES = 7;
const MIN_OVERVIEW_MODULES = 2;
const MAX_EXTERNAL_NODES = 2;
const MAX_DETAIL_PER_MODULE = 6;
const MAX_DETAIL_NODES = 36;
const MAX_FLOW_VIEWS = 4;
const MAX_VIEW_NODES = 12;
const PROJECTION_PREFIX = "architecture-projection:";

const ROLE_PATTERNS: Array<[ArchitectureRole, RegExp]> = [
  ["frontend", /(?:frontend|desktop|mobile|(^|[\/_\-.])(web|ui|client)([\/_\-.]|$))/i],
  ["backend", /(?:backend|api|server|gateway|rest|controller|webhook)/i],
  ["worker", /(?:worker|scheduler|dispatcher|orchestrator|cron)/i],
  ["executor", /(?:runner|executor|agent|probe|runtime)/i],
  ["data", /(^|[\/_\-.])(database|storage|repository|cache|redis|kafka|queue|mq)([\/_\-.]|$)/i],
  ["shared", /(^|[\/_\-.])(shared|common|contracts|schema|schemas|types|utils?|helpers?|libs?|sdk|core)([\/_\-.]|$)/i],
];

const DETAIL_ONLY_PATTERN = /(^|[\/_\-.])(test|tests|fixtures?|examples?|samples?|docs?|scripts?|benchmarks?|generated|mocks?|dist|build|out|accept|gates|skills?)([\/_\-.]|$)/i;
const IMPORTANT_DETAIL_PATTERN = /(?:controller|service|worker|runner|scheduler|dispatcher|orchestrator|repository|gateway|client|handler|router|scanner|parser|executor|consumer|producer|store|manager|engine)/i;
const LOCAL_RUNTIME_PATTERN = /(?:\blocal\b|desktop|本地|scanner|analysis[-_ ]?engine|analyzer|workspace)/i;
const CLOUD_RUNTIME_PATTERN = /(?:cloud|ecs|serverless|hosted|remote|backend|worker|runner|queue|gateway|server|service)/i;

const DISPLAY_GROUP_LABEL: Record<DisplayGroup, string> = {
  client: "客户端",
  "local-runtime": "本地分析环境",
  "cloud-runtime": "后端",
  shared: "共享契约与基础能力",
  external: "外部系统",
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function moduleId(fact: NormalizedFact, side: "subject" | "object"): string | null {
  const endpoint = side === "subject" ? fact.subject : fact.object;
  if (!endpoint) return null;
  if (endpoint.kind === "module") return endpoint.id;
  return endpoint.moduleId ?? null;
}

function uniqueEvidence(values: Array<Evidence | undefined>): Evidence[] {
  const unique = new Map<string, Evidence>();
  for (const value of values) {
    if (!value?.file) continue;
    const key = `${value.repositoryId ?? ""}:${value.file}:${value.startLine ?? 0}:${value.endLine ?? 0}:${value.factId ?? ""}`;
    if (!unique.has(key)) unique.set(key, value);
  }
  return [...unique.values()].slice(0, 8);
}

function classifyRole(
  node: GraphNode,
  moduleFact: NormalizedFact | undefined,
  relatedFacts: NormalizedFact[],
): ArchitectureRole {
  // 先判断节点自身的名字，避免父目录或摘要中的词覆盖节点的真实职责。
  // 例如 app/backend 的摘要包含 desktop，但它仍应被识别为 backend。
  for (const [role, pattern] of ROLE_PATTERNS) {
    if (pattern.test(node.name)) return role;
  }
  const haystack = [
    node.path ?? "",
    node.summary ?? "",
    String(moduleFact?.attributes?.packageName ?? ""),
    String(moduleFact?.attributes?.description ?? ""),
  ].join("/");
  for (const [role, pattern] of ROLE_PATTERNS) {
    if (pattern.test(haystack)) return role;
  }
  if (relatedFacts.some((fact) => fact.type === "route")) return "backend";
  if (relatedFacts.some((fact) =>
    moduleId(fact, "subject") === node.id &&
    fact.evidence.some((evidence) => /\.(?:tsx|jsx|vue|svelte)$/i.test(evidence.file)),
  )) return "frontend";
  if (relatedFacts.some((fact) =>
    moduleId(fact, "subject") === node.id && fact.type === "mq" && fact.relation === "consume",
  )) return "worker";
  return "domain";
}

function displayGroupFor(node: GraphNode, role: ArchitectureRole): DisplayGroup {
  if (node.architecture?.source === "semantic" && node.architecture.displayGroup) {
    return node.architecture.displayGroup;
  }
  const descriptor = `${node.name}/${node.path ?? ""}/${node.summary ?? ""}`;
  if (role === "external") return "external";
  if (role === "frontend") return "client";
  if (role === "shared") return "shared";
  if (LOCAL_RUNTIME_PATTERN.test(descriptor)) return "local-runtime";
  if (CLOUD_RUNTIME_PATTERN.test(descriptor) || ["backend", "worker", "executor", "data"].includes(role)) {
    return "cloud-runtime";
  }
  return "local-runtime";
}

function moduleSummary(metric: ModuleMetrics): string {
  const count = metric.fileCount > 0 ? `，包含 ${metric.fileCount} 个源文件` : "";
  switch (metric.role) {
    case "frontend": return `承载用户界面、页面渲染与客户端状态${count}`;
    case "backend": return `提供接口、业务服务与请求编排能力${count}`;
    case "worker": return `负责后台任务调度与异步处理${count}`;
    case "executor": return `负责受控任务执行、运行时处理与结果采集${count}`;
    case "data": return `封装数据访问、缓存或持久化能力${count}`;
    case "shared": return `提供跨模块共享的契约与基础能力${count}`;
    default: return `承载核心业务能力${count}`;
  }
}

function architectureScore(
  node: GraphNode,
  moduleFact: NormalizedFact | undefined,
  relatedFacts: NormalizedFact[],
): Omit<ModuleMetrics, "node"> {
  const role = classifyRole(node, moduleFact, relatedFacts);
  const fileCount = Number(moduleFact?.attributes?.fileCount ?? 0) || 0;
  const adjacentModules = new Set<string>();
  let entryCount = 0;
  let resourceCount = 0;

  for (const fact of relatedFacts) {
    const source = moduleId(fact, "subject");
    const target = moduleId(fact, "object");
    if (source === node.id && target && target !== node.id) adjacentModules.add(target);
    if (target === node.id && source && source !== node.id) adjacentModules.add(source);
    if (source === node.id && (fact.type === "route" || (fact.type === "mq" && fact.relation === "consume"))) {
      entryCount += 1;
    }
    if (source === node.id && ["db", "redis", "mq", "http_client"].includes(fact.type)) {
      resourceCount += 1;
    }
  }

  const declared = typeof moduleFact?.attributes?.packageName === "string" && Boolean(moduleFact.attributes.packageName);
  const descriptor = `${node.name}/${node.path ?? ""}`;
  const penalized = DETAIL_ONLY_PATTERN.test(descriptor);
  const roleBoost = ["frontend", "backend", "worker", "executor"].includes(role)
    ? 7
    : role === "data" ? 4 : role === "shared" ? -1 : 1;
  const score = Number((
    1 +
    Math.min(8, Math.log2(fileCount + 1) * 1.8) +
    Math.min(8, adjacentModules.size * 1.6) +
    Math.min(9, entryCount * 4.5) +
    Math.min(8, resourceCount * 2) +
    (declared ? 2 : 0) +
    roleBoost -
    (penalized ? 12 : 0)
  ).toFixed(3));

  return {
    role,
    score,
    fileCount,
    degree: adjacentModules.size,
    entryCount,
    resourceCount,
    declared,
    penalized,
  };
}

function chooseVisibleModules(metrics: ModuleMetrics[]): Set<string> {
  if (metrics.length === 0) return new Set();
  const ranked = [...metrics].sort((left, right) =>
    Number(Boolean(right.node.architecture?.visibleByDefault)) - Number(Boolean(left.node.architecture?.visibleByDefault)) ||
    right.score - left.score ||
    left.node.id.localeCompare(right.node.id),
  );
  const explicitHidden = new Set(ranked.filter((item) =>
    item.node.architecture?.source === "semantic" && !item.node.architecture.visibleByDefault,
  ).map((item) => item.node.id));
  const available = ranked.filter((item) => !explicitHidden.has(item.node.id));
  const selected = new Set(available
    .filter((item) => item.node.architecture?.source === "semantic" && item.node.architecture.visibleByDefault)
    .slice(0, MAX_OVERVIEW_MODULES)
    .map((item) => item.node.id));

  const operational = available.filter((item) =>
    !item.penalized && (
      ["frontend", "backend", "worker", "executor"].includes(item.role) ||
      item.entryCount > 0 ||
      item.resourceCount > 0 ||
      item.degree >= 3
    ),
  );
  for (const item of operational) {
    if (selected.size >= MAX_OVERVIEW_MODULES) break;
    selected.add(item.node.id);
  }
  for (const item of available) {
    if (selected.size >= MAX_OVERVIEW_MODULES) break;
    const substantial = item.declared || item.fileCount >= 4 || item.degree > 0 || item.entryCount > 0 || item.resourceCount > 0;
    if ((!item.penalized && substantial) || selected.size < Math.min(MIN_OVERVIEW_MODULES, metrics.length)) {
      selected.add(item.node.id);
    }
  }
  if (selected.size === 0 && ranked[0]) selected.add(ranked[0].node.id);
  return selected;
}

function projectionNodeId(repositoryId: string, suffix: string): string {
  return `${PROJECTION_PREFIX}${stableHash(repositoryId, suffix)}`;
}

function topModuleResolver(nodes: GraphNode[]): (nodeId: string) => string | null {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const cache = new Map<string, string | null>();
  return (nodeId: string): string | null => {
    const cached = cache.get(nodeId);
    if (cached !== undefined) return cached;
    let current = byId.get(nodeId);
    const visited = new Set<string>();
    while (current && current.parentId && !visited.has(current.id)) {
      visited.add(current.id);
      current = byId.get(current.parentId);
    }
    const result = current?.kind === "module" ? current.id : null;
    cache.set(nodeId, result);
    return result;
  };
}

function detailScore(node: GraphNode, degree: number): number {
  const kindBoost: Partial<Record<GraphNode["kind"], number>> = {
    submodule: 24,
    class: 8,
    interface: 7,
    function: 5,
    config: 3,
  };
  const descriptor = `${node.name}/${node.path ?? ""}`;
  const semanticBoost = node.architecture?.source === "semantic"
    ? node.architecture.importance === "primary" ? 40 : node.architecture.importance === "supporting" ? 18 : 0
    : 0;
  return (kindBoost[node.kind] ?? 1) +
    Math.min(12, degree * 2) +
    (IMPORTANT_DETAIL_PATTERN.test(descriptor) ? 8 : 0) +
    Math.min(3, node.evidence?.length ?? 0) +
    semanticBoost -
    (DETAIL_ONLY_PATTERN.test(descriptor) ? 20 : 0);
}

function selectImportantDetails(
  graph: GraphDocument,
  visibleModules: Set<string>,
  resolveTopModule: (nodeId: string) => string | null,
): Map<string, string[]> {
  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const result = new Map<string, string[]>();
  let remaining = MAX_DETAIL_NODES;
  for (const moduleIdValue of [...visibleModules].sort()) {
    if (remaining <= 0) break;
    const candidates = graph.nodes
      .filter((node) => node.id !== moduleIdValue && resolveTopModule(node.id) === moduleIdValue)
      .filter((node) => !node.kind.startsWith("infra.") && node.kind !== "external")
      .map((node) => ({ node, score: detailScore(node, degree.get(node.id) ?? 0) }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id))
      .slice(0, Math.min(MAX_DETAIL_PER_MODULE, remaining));
    const ids = candidates.map((candidate) => candidate.node.id);
    if (ids.length > 0) result.set(moduleIdValue, ids);
    remaining -= ids.length;
  }
  return result;
}

function resourceLabel(kind: GraphNode["kind"]): { name: string; summary: string } {
  if (kind === "infra.redis") return { name: "Redis", summary: "缓存、键空间与轻量队列资源" };
  if (kind === "infra.mq") return { name: "Message Queue", summary: "消息主题、生产与消费通道" };
  return { name: "Database", summary: "关系型数据表与持久化访问" };
}

function edgeLabel(type: GraphEdge["type"]): string {
  switch (type) {
    case "call": return "调用";
    case "dependency": return "依赖";
    case "read": return "读取";
    case "write": return "写入";
    case "publish": return "发布";
    case "consume": return "消费";
    case "implement": return "实现";
    case "contains": return "包含";
  }
}

function annotateExternal(node: GraphNode): GraphNode {
  return {
    ...node,
    domain: "external",
    architecture: {
      role: "external",
      importance: "supporting",
      visibleByDefault: true,
      source: node.architecture?.source ?? "deterministic",
      rationale: node.architecture?.rationale,
      displayGroup: "external",
      groupLabel: DISPLAY_GROUP_LABEL.external,
    },
  };
}

function aggregateEdgesForPresentation(
  graph: GraphDocument,
  publicNodes: GraphNode[],
  resolvePublicRoot: (nodeId: string) => string | null,
): GraphEdge[] {
  const publicIds = new Set(publicNodes.map((node) => node.id));
  const publicNodeById = new Map(publicNodes.map((node) => [node.id, node]));
  const memberOwner = new Map<string, string>();
  for (const node of publicNodes) {
    if (!node.id.startsWith(PROJECTION_PREFIX)) continue;
    for (const memberId of node.architecture?.memberNodeIds ?? []) memberOwner.set(memberId, node.id);
  }
  const endpoint = (nodeId: string): string | null => {
    if (publicIds.has(nodeId) && !publicNodeById.get(nodeId)?.parentId) return nodeId;
    const aggregate = memberOwner.get(nodeId);
    if (aggregate) return aggregate;
    const root = resolvePublicRoot(nodeId);
    return root && publicIds.has(root) ? root : null;
  };
  const grouped = new Map<string, { source: string; target: string; type: GraphEdge["type"]; edges: GraphEdge[] }>();
  for (const edge of graph.edges) {
    if (edge.id.startsWith(PROJECTION_PREFIX) || edge.type === "contains") continue;
    const source = endpoint(edge.source);
    const target = endpoint(edge.target);
    if (!source || !target || source === target) continue;
    const key = `${source}\u0000${target}\u0000${edge.type}`;
    const group = grouped.get(key) ?? { source, target, type: edge.type, edges: [] };
    group.edges.push(edge);
    grouped.set(key, group);
  }
  return [...grouped.values()].map((group): GraphEdge => ({
    id: `${PROJECTION_PREFIX}edge:${stableHash(graph.repositoryId ?? graph.projectId, group.source, group.target, group.type)}`,
    source: group.source,
    target: group.target,
    type: group.type,
    label: edgeLabel(group.type),
    inferred: group.edges.every((edge) => Boolean(edge.inferred)),
    certainty: group.edges.some((edge) => edge.certainty === "exact") ? "exact" : "resolved",
    repositoryId: graph.repositoryId,
    factIds: [...new Set(group.edges.flatMap((edge) => edge.factIds ?? []))].sort(),
    evidence: uniqueEvidence(group.edges.flatMap((edge) => edge.evidence ?? [])),
  })).sort((left, right) => left.id.localeCompare(right.id));
}

function addRuntimeBoundaryEdges(
  graph: GraphDocument,
  factIndex: FactIndex,
  publicNodes: GraphNode[],
  edges: GraphEdge[],
  promotedIds: Set<string>,
): GraphEdge[] {
  const result = [...edges];
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const publicById = new Map(publicNodes.map((node) => [node.id, node]));
  const hasEdge = (source: string, target: string): boolean =>
    result.some((edge) => edge.source === source && edge.target === target);
  const pushBoundary = (
    source: string,
    target: string,
    evidence: Evidence[],
    reason: string,
  ): void => {
    if (!publicById.has(source) || !publicById.has(target) || hasEdge(source, target)) return;
    result.push({
      id: `${PROJECTION_PREFIX}boundary:${stableHash(graph.repositoryId ?? graph.projectId, source, target, reason)}`,
      source,
      target,
      type: "call",
      label: "调用",
      inferred: true,
      certainty: "resolved",
      repositoryId: graph.repositoryId,
      evidence: uniqueEvidence(evidence),
    });
  };
  const normalizedHttpPath = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const apiStart = value.indexOf("/api/");
    if (apiStart < 0) return null;
    return value
      .slice(apiStart)
      .replace(/\$\{[^}]+\}/g, ":param")
      .replace(/:[^/]+/g, ":param")
      .replace(/\?.*$/, "");
  };

  // 客户端包中的本地后端来自真实源码分区，并保留该分区的源码证据。
  for (const promotedId of promotedIds) {
    const promoted = nodeById.get(promotedId);
    const parentId = promoted?.parentId;
    if (!promoted || !parentId) continue;
    const facts = factIndex.facts.filter((fact) =>
      fact.evidence.some((item) => Boolean(promoted.path && item.file.startsWith(`${promoted.path}/`))),
    );
    pushBoundary(
      parentId,
      promotedId,
      [
        ...(promoted.evidence ?? []),
        ...facts.flatMap((fact) => fact.evidence.map((item) => ({ ...item, factId: fact.factId }))),
      ],
      "local-backend-boundary",
    );
  }

  // 按 HTTP 路径契约匹配客户端与真实路由提供者；动态参数统一成 :param。
  // 只有无法获得路径且仓库内仅有一个云端后端时，才使用唯一提供者回退。
  const cloudBackends = publicNodes.filter((node) =>
    !node.parentId &&
    node.architecture?.displayGroup === "cloud-runtime" &&
    node.architecture.role === "backend",
  );
  const frontends = publicNodes.filter((node) =>
    !node.parentId && node.architecture?.role === "frontend",
  );
  for (const frontend of frontends) {
    const clientFacts = factIndex.facts.filter((fact) =>
      fact.type === "http_client" && (fact.subject.moduleId ?? fact.subject.id) === frontend.id,
    );
    if (clientFacts.length === 0) continue;
    const clientPaths = new Set(clientFacts
      .map((fact) => normalizedHttpPath(fact.attributes?.target))
      .filter((value): value is string => Boolean(value)));
    const matchedBackends = cloudBackends.filter((backend) => {
      const routePaths = factIndex.facts
        .filter((fact) => fact.type === "route" && (fact.subject.moduleId ?? fact.subject.id) === backend.id)
        .map((fact) => normalizedHttpPath(fact.attributes?.path))
        .filter((value): value is string => Boolean(value));
      return routePaths.some((path) => clientPaths.has(path));
    });
    const providers = matchedBackends.length > 0
      ? matchedBackends
      : cloudBackends.length === 1 ? cloudBackends : [];
    for (const backend of providers) {
      const routeFacts = factIndex.facts.filter((fact) =>
        fact.type === "route" && (fact.subject.moduleId ?? fact.subject.id) === backend.id,
      );
      if (routeFacts.length === 0) continue;
      pushBoundary(
        frontend.id,
        backend.id,
        [
          ...clientFacts.flatMap((fact) => fact.evidence.map((item) => ({ ...item, factId: fact.factId }))),
          ...routeFacts.flatMap((fact) => fact.evidence.map((item) => ({ ...item, factId: fact.factId }))),
        ],
        "http-client-to-route-provider",
      );
    }
  }

  return result.sort((left, right) => left.id.localeCompare(right.id));
}

function graphView(id: string, name: string, nodeIds: string[], edges: GraphEdge[]): GraphView | null {
  const uniqueNodeIds = [...new Set(nodeIds)].slice(0, MAX_VIEW_NODES);
  if (uniqueNodeIds.length < 2) return null;
  const nodeSet = new Set(uniqueNodeIds);
  const viewEdges = edges.filter((edge) => nodeSet.has(edge.source) && nodeSet.has(edge.target));
  if (viewEdges.length === 0 && id !== "overview") return null;
  return { id, name, nodeIds: uniqueNodeIds, edgeIds: viewEdges.map((edge) => edge.id) };
}

function neighborIds(seed: Set<string>, edges: GraphEdge[]): Set<string> {
  const result = new Set(seed);
  for (const edge of edges) {
    if (seed.has(edge.source)) result.add(edge.target);
    if (seed.has(edge.target)) result.add(edge.source);
  }
  return result;
}

function buildPresentationViews(nodes: GraphNode[], edges: GraphEdge[]): GraphView[] {
  const topNodes = nodes.filter((node) => !node.parentId);
  const topIds = topNodes.map((node) => node.id);
  const overview = graphView("overview", "总体架构", topIds, edges)
    ?? { id: "overview", name: "总体架构", nodeIds: topIds, edgeIds: [] };
  const generated: Array<GraphView | null> = [overview];

  const requestSeeds = new Set(topNodes
    .filter((node) => ["frontend", "backend"].includes(node.architecture?.role ?? ""))
    .map((node) => node.id));
  generated.push(graphView("flow:request", "请求处理", [...neighborIds(requestSeeds, edges)], edges));

  const asyncSeeds = new Set(topNodes
    .filter((node) => ["worker", "executor"].includes(node.architecture?.role ?? "") || node.kind === "infra.mq")
    .map((node) => node.id));
  generated.push(graphView("flow:async", "异步任务", [...neighborIds(asyncSeeds, edges)], edges));

  const dataSeeds = new Set(topNodes
    .filter((node) => node.kind === "infra.db" || node.kind === "infra.redis" || node.architecture?.role === "data")
    .map((node) => node.id));
  generated.push(graphView("flow:data", "数据访问", [...neighborIds(dataSeeds, edges)], edges));

  const externalSeeds = new Set(topNodes.filter((node) => node.kind === "external").map((node) => node.id));
  generated.push(graphView("flow:external", "外部集成", [...neighborIds(externalSeeds, edges)], edges));

  return orderGraphViews(generated.filter((view): view is GraphView => Boolean(view)).slice(0, MAX_FLOW_VIEWS + 1));
}

/**
 * 给全量事实图补充架构语义。该图供 Planner、Agent、质量门禁和证据检索使用，
 * 因此不会删除符号、路由或资源事实。
 */
export function annotateArchitectureGraph(input: GraphDocument, factIndex: FactIndex): GraphDocument {
  const graph = clone(input);
  graph.nodes = graph.nodes.filter((node) => !node.id.startsWith(PROJECTION_PREFIX));
  graph.edges = graph.edges.filter((edge) => !edge.id.startsWith(PROJECTION_PREFIX));
  const sourceNodeCount = graph.nodes.length;
  const sourceEdgeCount = graph.edges.length;

  const moduleFacts = new Map(factIndex.facts
    .filter((fact) => fact.type === "module" && fact.attributes?.nodeKind === "module")
    .map((fact) => [fact.subject.id, fact]));
  const factsByModule = new Map<string, NormalizedFact[]>();
  for (const fact of factIndex.facts) {
    for (const id of new Set([moduleId(fact, "subject"), moduleId(fact, "object")].filter(Boolean) as string[])) {
      factsByModule.set(id, [...(factsByModule.get(id) ?? []), fact]);
    }
  }
  const moduleNodes = graph.nodes.filter((node) => node.kind === "module" && !node.parentId);
  const metrics = moduleNodes.map((node): ModuleMetrics => {
    const moduleFact = moduleFacts.get(node.id);
    const displayName = node.name === "." || node.name.trim() === ""
      ? moduleFact?.subject.name || factIndex.repositoryId
      : node.name;
    const displayNode = displayName === node.name ? node : { ...node, name: displayName };
    const computed = architectureScore(displayNode, moduleFact, factsByModule.get(node.id) ?? []);
    const semantic = node.architecture?.source === "semantic" ? node.architecture : null;
    return {
      node: displayNode,
      ...computed,
      role: semantic?.role ?? computed.role,
      score: semantic?.importance === "primary"
        ? Math.max(100, computed.score)
        : semantic?.importance === "supporting" ? Math.max(50, computed.score) : computed.score,
    };
  });
  const visibleModules = chooseVisibleModules(metrics);
  const resolveTopModule = topModuleResolver(graph.nodes);
  const selectedDetails = selectImportantDetails(graph, visibleModules, resolveTopModule);
  const sortedScores = metrics.map((item) => item.score).sort((left, right) => right - left);
  const primaryCutoff = sortedScores[Math.min(sortedScores.length - 1, Math.max(1, Math.floor(sortedScores.length / 3)))] ?? 0;
  const metricByNode = new Map(metrics.map((item) => [item.node.id, item]));
  const selectedDetailIds = new Set([...selectedDetails.values()].flat());

  graph.nodes = graph.nodes.map((node) => {
    const metric = metricByNode.get(node.id);
    if (metric) {
      const semantic = node.architecture?.source === "semantic" ? node.architecture : null;
      const visible = visibleModules.has(node.id);
      const role = semantic?.role ?? metric.role;
      const displayGroup = semantic?.displayGroup ?? displayGroupFor(node, role);
      return {
        ...node,
        name: metric.node.name,
        summary: !node.summary || /(?:代码模块|shared orchestration code)$/.test(node.summary)
          ? moduleSummary(metric)
          : node.summary,
        architecture: {
          role,
          importance: semantic?.importance ?? (visible ? (metric.score >= primaryCutoff ? "primary" : "supporting") : "detail"),
          score: metric.score,
          visibleByDefault: semantic?.visibleByDefault ?? visible,
          source: semantic?.source ?? "deterministic",
          rationale: semantic?.rationale ?? `files=${metric.fileCount}, degree=${metric.degree}, entries=${metric.entryCount}, resources=${metric.resourceCount}`,
          memberNodeIds: selectedDetails.get(node.id) ?? [],
          displayGroup,
          groupLabel: semantic?.groupLabel ?? DISPLAY_GROUP_LABEL[displayGroup],
        },
      };
    }
    if (node.parentId || ["submodule", "class", "function", "interface", "config"].includes(node.kind)) {
      const selected = selectedDetailIds.has(node.id);
      const topModuleId = resolveTopModule(node.id);
      const parentMetric = topModuleId ? metricByNode.get(topModuleId) : undefined;
      const inferredRole = selected ? classifyRole(node, undefined, []) : node.architecture?.role ?? "domain";
      const role = inferredRole === "domain" && parentMetric ? parentMetric.role : inferredRole;
      const semanticGroup = node.architecture?.source === "semantic"
        ? node.architecture.displayGroup
        : undefined;
      // 细节节点通常与所属主模块部署在同一运行环境，不能仅凭 scanner、worker
      // 等目录名就把它们误判成另一个顶层系统。
      let displayGroup = semanticGroup ?? (parentMetric
        ? displayGroupFor(parentMetric.node, parentMetric.role)
        : displayGroupFor(node, role));
      if (selected && role === "backend" && parentMetric?.role === "frontend") displayGroup = "local-runtime";
      return {
        ...node,
        architecture: {
          role,
          importance: selected ? "supporting" : "detail",
          score: node.architecture?.score,
          visibleByDefault: false,
          source: node.architecture?.source ?? "deterministic",
          rationale: node.architecture?.rationale,
          displayGroup,
          groupLabel: semanticGroup
            ? node.architecture?.groupLabel ?? DISPLAY_GROUP_LABEL[displayGroup]
            : DISPLAY_GROUP_LABEL[displayGroup],
        },
      };
    }
    return node;
  });

  const projectionNodes: GraphNode[] = [];
  for (const kind of ["infra.db", "infra.redis", "infra.mq"] as const) {
    const resources = graph.nodes.filter((node) => node.kind === kind);
    if (resources.length === 0) continue;
    const label = resourceLabel(kind);
    projectionNodes.push({
      id: projectionNodeId(factIndex.repositoryId, kind),
      name: label.name,
      kind,
      domain: "cloud-runtime",
      summary: `${label.summary}，汇总 ${resources.length} 个已识别资源`,
      evidence: uniqueEvidence(resources.flatMap((resource) => resource.evidence ?? [])),
      inferred: true,
      repositoryId: factIndex.repositoryId,
      factIds: [...new Set(resources.flatMap((resource) => resource.factIds ?? []))].sort(),
      certainty: "resolved",
      architecture: {
        role: "data",
        importance: "primary",
        visibleByDefault: true,
        source: "deterministic",
        memberNodeIds: resources.map((resource) => resource.id).sort(),
        displayGroup: "cloud-runtime",
        groupLabel: DISPLAY_GROUP_LABEL["cloud-runtime"],
      },
    });
  }

  const externalNodes = graph.nodes.filter((node) => node.kind === "external");
  const connectedExternal = externalNodes.filter((node) => graph.edges.some((edge) => {
    const other = edge.source === node.id ? edge.target : edge.target === node.id ? edge.source : null;
    const top = other ? resolveTopModule(other) : null;
    return Boolean(top && visibleModules.has(top));
  }));
  if (connectedExternal.length > MAX_EXTERNAL_NODES) {
    projectionNodes.push({
      id: projectionNodeId(factIndex.repositoryId, "external"),
      name: "External Services",
      kind: "external",
      domain: "external",
      summary: `代码直接访问的外部系统，汇总 ${connectedExternal.length} 个目标`,
      evidence: uniqueEvidence(connectedExternal.flatMap((node) => node.evidence ?? [])),
      inferred: true,
      repositoryId: factIndex.repositoryId,
      factIds: [...new Set(connectedExternal.flatMap((node) => node.factIds ?? []))].sort(),
      certainty: "resolved",
      architecture: {
        role: "external",
        importance: "supporting",
        visibleByDefault: true,
        source: "deterministic",
        memberNodeIds: connectedExternal.map((node) => node.id).sort(),
        displayGroup: "external",
        groupLabel: DISPLAY_GROUP_LABEL.external,
      },
    });
  } else {
    const ids = new Set(connectedExternal.map((node) => node.id));
    graph.nodes = graph.nodes.map((node) => ids.has(node.id) ? annotateExternal(node) : node);
  }

  graph.nodes.push(...projectionNodes);
  const overviewNodeIds = graph.nodes
    .filter((node) => (visibleModules.has(node.id) || node.id.startsWith(PROJECTION_PREFIX) ||
      (node.kind === "external" && node.architecture?.visibleByDefault)))
    .map((node) => node.id)
    .sort();
  const publicSeedNodes = graph.nodes.filter((node) => overviewNodeIds.includes(node.id));
  const overviewEdges = aggregateEdgesForPresentation(
    graph,
    publicSeedNodes,
    (nodeId) => {
      const module = resolveTopModule(nodeId);
      return module && visibleModules.has(module) ? module : null;
    },
  );
  graph.edges.push(...overviewEdges);
  const views = new Map((graph.views ?? []).map((view) => [view.id, view]));
  views.set("overview", { id: "overview", name: "总体架构", nodeIds: overviewNodeIds, edgeIds: overviewEdges.map((edge) => edge.id) });
  graph.views = orderGraphViews([...views.values()]);
  graph.nodes.sort((left, right) => left.id.localeCompare(right.id));
  graph.edges.sort((left, right) => left.id.localeCompare(right.id));
  graph.architectureProjection = {
    version: "1.0",
    visibleNodeCount: overviewNodeIds.length,
    visibleModuleCount: visibleModules.size,
    hiddenDetailCount: Math.max(0, sourceNodeCount - overviewNodeIds.length),
    sourceNodeCount,
    sourceEdgeCount,
    detailNodeCount: selectedDetailIds.size,
  };
  graph.stats = computeStats(graph);
  return graph;
}

/**
 * 从全量事实图生成 Electron 使用的人类可读投影。只有主模块、聚合资源、
 * 少量外部系统和右侧详情候选会进入 graph.json。
 */
export function buildArchitecturePresentation(input: GraphDocument, factIndex: FactIndex): GraphDocument {
  if (input.architectureProjection?.version === "2.0") return clone(input);
  const graph = input.architectureProjection?.version === "1.0"
    ? clone(input)
    : annotateArchitectureGraph(input, factIndex);
  const sourceNodeCount = graph.architectureProjection?.sourceNodeCount
    ?? graph.nodes.filter((node) => !node.id.startsWith(PROJECTION_PREFIX)).length;
  const sourceEdgeCount = graph.architectureProjection?.sourceEdgeCount
    ?? graph.edges.filter((edge) => !edge.id.startsWith(PROJECTION_PREFIX)).length;
  const visibleModules = new Set(graph.nodes
    .filter((node) => node.kind === "module" && !node.parentId && node.architecture?.visibleByDefault)
    .map((node) => node.id));
  const resolveTopModule = topModuleResolver(graph.nodes);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const detailIds = new Set(graph.nodes
    .filter((node) => visibleModules.has(node.id))
    .flatMap((node) => node.architecture?.memberNodeIds ?? []));
  // 当一个部署包同时包含客户端与本地后端时，只提升跨运行边界的关键分区。
  // 例如 Electron app 仍作为客户端节点，同时把 app/backend 提升为本地分析服务；
  // 同一云端包内的 api/worker 继续留在右侧详情，不把总览拆碎。
  const promotedIds = new Set<string>();
  for (const moduleIdValue of visibleModules) {
    const parent = nodeById.get(moduleIdValue);
    for (const memberId of parent?.architecture?.memberNodeIds ?? []) {
      const member = nodeById.get(memberId);
      // 总览只提升真正跨运行边界的分区：客户端包里的本地后端。
      // 云端服务内部的 scanner/worker/api 等继续作为右侧重要组件展示。
      if (
        member?.kind === "submodule" &&
        parent?.architecture?.displayGroup === "client" &&
        parent.architecture.role === "frontend" &&
        member.architecture?.displayGroup === "local-runtime" &&
        member.architecture.role === "backend"
      ) promotedIds.add(member.id);
    }
  }
  const promotedMembers = new Map<string, string[]>();
  for (const promotedId of promotedIds) {
    const promoted = nodeById.get(promotedId);
    if (!promoted?.path) continue;
    const members = graph.nodes
      .filter((node) => node.id !== promotedId && Boolean(node.path?.startsWith(`${promoted.path}/`)))
      .filter((node) => !node.kind.startsWith("infra.") && node.kind !== "external")
      .map((node) => ({ node, score: detailScore(node, graph.edges.filter((edge) => edge.source === node.id || edge.target === node.id).length) }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id))
      .slice(0, 4)
      .map((candidate) => candidate.node.id);
    promotedMembers.set(promotedId, members);
    for (const id of members) detailIds.add(id);
  }
  const promotedPaths = [...promotedIds]
    .map((id) => ({ id, path: nodeById.get(id)?.path }))
    .filter((item): item is { id: string; path: string } => Boolean(item.path))
    .sort((left, right) => right.path.length - left.path.length);
  const promotedParent = (node: GraphNode): string | null => {
    if (promotedIds.has(node.id)) return node.id;
    const nodePath = node.path;
    if (!nodePath) return null;
    return promotedPaths.find((item) => nodePath === item.path || nodePath.startsWith(`${item.path}/`))?.id ?? null;
  };
  const publicNodes = graph.nodes
    .filter((node) => visibleModules.has(node.id) || detailIds.has(node.id) || node.id.startsWith(PROJECTION_PREFIX) ||
      (node.kind === "external" && node.architecture?.visibleByDefault))
    .map((node) => {
      if (promotedIds.has(node.id)) {
        return {
          ...node,
          parentId: null,
          architecture: {
            ...node.architecture!,
            importance: "primary" as const,
            visibleByDefault: true,
            memberNodeIds: promotedMembers.get(node.id) ?? [],
          },
        };
      }
      if (visibleModules.has(node.id)) {
        return {
          ...node,
          architecture: {
            ...node.architecture!,
            memberNodeIds: (node.architecture?.memberNodeIds ?? []).filter((id) => !promotedIds.has(id)),
          },
        };
      }
      if (!detailIds.has(node.id)) return node;
      const parentId = promotedParent(node) ?? resolveTopModule(node.id);
      return { ...node, parentId, architecture: { ...node.architecture!, visibleByDefault: false } };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const aggregatedEdges = aggregateEdgesForPresentation(graph, publicNodes, (nodeId) => {
    const node = nodeById.get(nodeId);
    const promoted = node ? promotedParent(node) : null;
    if (promoted) return promoted;
    const module = resolveTopModule(nodeId);
    return module && visibleModules.has(module) ? module : null;
  });
  const publicEdges = addRuntimeBoundaryEdges(graph, factIndex, publicNodes, aggregatedEdges, promotedIds);
  const presentation: GraphDocument = {
    ...graph,
    nodes: publicNodes,
    edges: publicEdges,
    views: buildPresentationViews(publicNodes, publicEdges),
    graphLayer: "final",
    architectureProjection: {
      version: "2.0",
      visibleNodeCount: publicNodes.filter((node) => !node.parentId).length,
      visibleModuleCount: visibleModules.size,
      hiddenDetailCount: Math.max(0, sourceNodeCount - publicNodes.length),
      sourceNodeCount,
      sourceEdgeCount,
      detailNodeCount: detailIds.size,
    },
  };
  presentation.stats = computeStats(presentation);
  return presentation;
}

/** Backward-compatible helper used by focused projection tests. */
export function applyArchitectureProjection(input: GraphDocument, factIndex: FactIndex): GraphDocument {
  return buildArchitecturePresentation(input, factIndex);
}
