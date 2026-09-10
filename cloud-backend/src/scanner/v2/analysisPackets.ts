import type { GraphDocument } from "../../types";
import { stableHash } from "./ids";
import type {
  DiagnosticsDocument,
  FactIndex,
  InterfaceCatalog,
  NormalizedFact,
  ResourceCatalog,
  SymbolIndex,
} from "./contracts";

export interface AnalysisPacketEvidence {
  factId: string;
  file: string;
  startLine: number;
  endLine: number;
  excerptHash: string;
}

export interface AnalysisPacket {
  packetId: string;
  packetHash: string;
  projectId: string;
  repositoryId: string;
  commitSha: string;
  module: {
    id: string;
    name: string;
    path: string | null;
    role?: string;
    importance?: string;
  };
  entryFactIds: string[];
  publicSymbolIds: string[];
  relatedFactIds: string[];
  incomingModuleIds: string[];
  outgoingModuleIds: string[];
  interfaceIds: string[];
  resourceIds: string[];
  diagnosticIds: string[];
  allowedFiles: string[];
  evidence: AnalysisPacketEvidence[];
  questions: string[];
  budget: {
    maxFiles: number;
    maxSourceBytes: number;
    maxTurns: number;
  };
  priority: "changed" | "normal";
}

export interface AnalysisPlan {
  schemaVersion: "1.0";
  plannerVersion: "1.1.0";
  projectId: string;
  repositoryId: string;
  commitSha: string;
  generatedAt: string;
  packets: AnalysisPacket[];
}

export interface AnalysisPlanInput {
  projectId: string;
  factIndex: FactIndex;
  symbolIndex: SymbolIndex;
  interfaceCatalog: InterfaceCatalog;
  resourceCatalog: ResourceCatalog;
  diagnostics: DiagnosticsDocument;
  baseGraph: GraphDocument;
  changedFiles?: string[];
}

const STANDARD_QUESTIONS = [
  "该模块解决什么问题，职责边界是什么？",
  "模块的入口、对外接口和关键调用链是什么？",
  "模块依赖哪些代码模块、存储、缓存、队列或外部服务？",
  "Fact Index 是否漏掉节点、关系或错误标注了方向？",
  "有哪些由源码证据支持的风险、约束和维护注意事项？",
] as const;

function endpointModuleId(fact: NormalizedFact, side: "subject" | "object"): string | null {
  const endpoint = side === "subject" ? fact.subject : fact.object;
  if (!endpoint) return null;
  if (endpoint.kind === "module") return endpoint.id;
  return endpoint.moduleId ?? null;
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

function packetHash(packet: Omit<AnalysisPacket, "packetHash">): string {
  return `packet:${stableHash(JSON.stringify(packet))}`;
}

export function buildAnalysisPlan(input: AnalysisPlanInput): AnalysisPlan {
  const changedFiles = new Set((input.changedFiles ?? []).map((file) =>
    file.replaceAll("\\", "/").replace(/^\.\//, ""),
  ));
  const overview = input.baseGraph.views?.find((view) => view.id === "overview");
  const overviewNodeIds = new Set(overview?.nodeIds ?? []);
  const allModuleNodes = input.baseGraph.nodes.filter((node) => node.kind === "module");
  const nonRootModulePaths = allModuleNodes
    .map((node) => node.path?.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, ""))
    .filter((modulePath): modulePath is string => Boolean(modulePath && modulePath !== "."));
  const changedModuleIds = new Set(allModuleNodes.filter((node) => {
    if (!node.path || changedFiles.size === 0) return false;
    const modulePath = node.path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    if (modulePath === ".") {
      return [...changedFiles].some((file) =>
        !nonRootModulePaths.some((ownedPath) => file === ownedPath || file.startsWith(`${ownedPath}/`)),
      );
    }
    return [...changedFiles].some((file) => file === modulePath || file.startsWith(`${modulePath}/`));
  }).map((node) => node.id));
  const impactedModuleIds = new Set(changedModuleIds);
  if (changedModuleIds.size > 0) {
    for (const fact of input.factIndex.facts) {
      const source = endpointModuleId(fact, "subject");
      const target = endpointModuleId(fact, "object");
      if (source && target && (changedModuleIds.has(source) || changedModuleIds.has(target))) {
        impactedModuleIds.add(source);
        impactedModuleIds.add(target);
      }
    }
  }
  // 默认只为架构投影中的主要/支撑模块启动语义 Agent；被改动的隐藏模块仍强制纳入。
  // 完整 Fact Index 与 Base Graph 不裁剪，全局汇总仍能看到全部确定性事实。
  // 增量模式只分析改动模块及一跳邻居，避免每次 push 再跑一遍全部 overview Agent。
  const projectedModules = changedFiles.size > 0 && changedModuleIds.size > 0
    ? allModuleNodes.filter((node) => impactedModuleIds.has(node.id))
    : allModuleNodes.filter((node) => overviewNodeIds.has(node.id) || changedModuleIds.has(node.id));
  const moduleNodes = projectedModules.length > 0 ? projectedModules : allModuleNodes;
  const packets = moduleNodes.map((module): AnalysisPacket => {
    const relatedFacts = input.factIndex.facts.filter((fact) =>
      endpointModuleId(fact, "subject") === module.id || endpointModuleId(fact, "object") === module.id,
    );
    const outgoingModuleIds = unique(relatedFacts.map((fact) => {
      const source = endpointModuleId(fact, "subject");
      const target = endpointModuleId(fact, "object");
      return source === module.id && target !== module.id ? target : null;
    }));
    const incomingModuleIds = unique(relatedFacts.map((fact) => {
      const source = endpointModuleId(fact, "subject");
      const target = endpointModuleId(fact, "object");
      return target === module.id && source !== module.id ? source : null;
    }));
    const interfaces = input.interfaceCatalog.interfaces.filter((record) => record.moduleId === module.id);
    const resources = input.resourceCatalog.resources.filter((record) => record.moduleId === module.id);
    const diagnostics = input.diagnostics.diagnostics.filter((diagnostic) => diagnostic.moduleId === module.id);
    const publicSymbols = input.symbolIndex.definitions.filter((definition) =>
      definition.moduleId === module.id && definition.exported,
    );
    const evidence = [...new Map(
      relatedFacts.flatMap((fact) => fact.evidence.map((item) => [
        `${fact.factId}:${item.file}:${item.startLine}`,
        {
          factId: fact.factId,
          file: item.file,
          startLine: item.startLine,
          endLine: item.endLine,
          excerptHash: item.excerptHash,
        } satisfies AnalysisPacketEvidence,
      ] as const)),
    ).values()]
      .sort((left, right) => `${left.file}:${left.startLine}`.localeCompare(`${right.file}:${right.startLine}`))
      .slice(0, 400);
    const allowedFiles = unique([
      ...evidence.map((item) => item.file),
      ...publicSymbols.map((definition) => definition.file),
      ...diagnostics.map((diagnostic) => diagnostic.file),
    ]);
    const priority = allowedFiles.some((file) => changedFiles.has(file)) ? "changed" : "normal";
    const withoutHash: Omit<AnalysisPacket, "packetHash"> = {
      packetId: `packet:${stableHash(input.factIndex.repositoryId, input.factIndex.commitSha, module.id)}`,
      projectId: input.projectId,
      repositoryId: input.factIndex.repositoryId,
      commitSha: input.factIndex.commitSha,
      module: {
        id: module.id,
        name: module.name,
        path: module.path ?? null,
        role: module.architecture?.role,
        importance: module.architecture?.importance,
      },
      entryFactIds: unique(relatedFacts
        .filter((fact) => fact.type === "route" || (fact.type === "mq" && fact.relation === "consume"))
        .map((fact) => fact.factId)),
      publicSymbolIds: publicSymbols.map((definition) => definition.symbolId).sort(),
      relatedFactIds: relatedFacts.map((fact) => fact.factId).sort(),
      incomingModuleIds,
      outgoingModuleIds,
      interfaceIds: interfaces.map((record) => record.interfaceId).sort(),
      resourceIds: resources.map((record) => record.resourceId).sort(),
      diagnosticIds: diagnostics.map((diagnostic) => diagnostic.diagnosticId).sort(),
      allowedFiles,
      evidence,
      questions: [...STANDARD_QUESTIONS],
      budget: {
        maxFiles: Math.min(24, Math.max(8, allowedFiles.length)),
        maxSourceBytes: 60_000,
        maxTurns: 1,
      },
      priority,
    };
    return { ...withoutHash, packetHash: packetHash(withoutHash) };
  }).sort((left, right) => left.module.id.localeCompare(right.module.id));

  return {
    schemaVersion: "1.0",
    plannerVersion: "1.1.0",
    projectId: input.projectId,
    repositoryId: input.factIndex.repositoryId,
    commitSha: input.factIndex.commitSha,
    generatedAt: new Date().toISOString(),
    packets,
  };
}
