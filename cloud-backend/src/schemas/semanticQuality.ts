import { createHash } from "node:crypto";
import type { GraphDocument, GraphEdge, GraphView } from "../types";
import type { DiagnosticsDocument, FactIndex } from "../scanner/v2/contracts";
import { validateGraph } from "./graphValidator";

export type QualityDisposition = "pass" | "warning" | "retry" | "hard_fail";

export interface QualityMetric {
  id:
    | "declared_module_coverage"
    | "critical_entry_coverage"
    | "locatable_evidence_rate"
    | "ungrounded_fact_rate"
    | "deterministic_direction_rate"
    | "critical_flow_continuity"
    | "deterministic_rerun_stability";
  label: string;
  value: number;
  target: number;
  numerator: number;
  denominator: number;
  disposition: QualityDisposition;
}

export interface QualityIssue {
  code: string;
  disposition: Exclude<QualityDisposition, "pass">;
  message: string;
  nodeId?: string;
  edgeId?: string;
  factId?: string;
  moduleId?: string;
}

export interface SemanticQualityReport {
  schemaVersion: "1.0";
  repositoryId: string;
  commitSha: string;
  createdAt: string;
  disposition: QualityDisposition;
  publishable: boolean;
  graphFingerprint: string;
  metrics: QualityMetric[];
  issues: QualityIssue[];
  retryScopes: string[];
  unresolvedCount: number;
}

export interface QualityOptions {
  fileExists?: (relativePath: string) => boolean;
  previousBaseGraph?: GraphDocument;
  thresholds?: Partial<Record<QualityMetric["id"], number>>;
}

const DEFAULT_TARGETS: Record<QualityMetric["id"], number> = {
  declared_module_coverage: 1,
  critical_entry_coverage: 0.95,
  locatable_evidence_rate: 1,
  ungrounded_fact_rate: 0,
  deterministic_direction_rate: 1,
  critical_flow_continuity: 1,
  deterministic_rerun_stability: 1,
};

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function dispositionRank(value: QualityDisposition): number {
  return { pass: 0, warning: 1, retry: 2, hard_fail: 3 }[value];
}

function worst(values: QualityDisposition[]): QualityDisposition {
  return values.sort((left, right) => dispositionRank(right) - dispositionRank(left))[0] ?? "pass";
}

export function graphFingerprint(graph: GraphDocument): string {
  const stable = JSON.stringify({
    nodes: graph.nodes.map((node) => ({ id: node.id, kind: node.kind, parentId: node.parentId ?? null })).sort((a, b) => a.id.localeCompare(b.id)),
    edges: graph.edges.map((edge) => ({ source: edge.source, target: edge.target, type: edge.type })).sort((a, b) =>
      `${a.source}:${a.target}:${a.type}`.localeCompare(`${b.source}:${b.target}:${b.type}`),
    ),
  });
  return createHash("sha256").update(stable).digest("hex");
}

function viewContinuity(view: GraphView, edges: Map<string, GraphEdge>): { valid: number; total: number } {
  const steps = [...(view.steps ?? [])].sort((left, right) => left.order - right.order);
  if (steps.length === 0) return { valid: 0, total: 0 };
  let valid = 0;
  for (let index = 0; index < steps.length; index += 1) {
    const edge = edges.get(steps[index]!.edgeId);
    if (!edge) continue;
    const next = steps[index + 1];
    if (!next) {
      valid += 1;
      continue;
    }
    const nextEdge = edges.get(next.edgeId);
    if (nextEdge && edge.target === nextEdge.source) valid += 1;
  }
  return { valid, total: steps.length };
}

export function evaluateSemanticQuality(
  graph: GraphDocument,
  factIndex: FactIndex,
  diagnostics: DiagnosticsDocument,
  options: QualityOptions = {},
): SemanticQualityReport {
  const targets = { ...DEFAULT_TARGETS, ...(options.thresholds ?? {}) };
  const issues: QualityIssue[] = [];
  const graphValidation = validateGraph(graph, { fileExists: options.fileExists });
  for (const error of graphValidation.errors) {
    issues.push({ code: "GRAPH_INVALID", disposition: "hard_fail", message: error });
  }

  const declaredModuleIds = new Set(
    factIndex.facts
      .filter((fact) => fact.type === "module" && fact.attributes?.nodeKind === "module")
      .map((fact) => fact.subject.id),
  );
  const modeledModuleIds = new Set(graph.nodes.filter((node) => node.kind === "module").map((node) => node.id));
  const coveredModules = [...declaredModuleIds].filter((id) => modeledModuleIds.has(id));

  const entryFactIds = new Set(factIndex.facts.filter((fact) => fact.type === "route").map((fact) => fact.factId));
  const graphFactIds = new Set([
    ...graph.nodes.flatMap((node) => node.factIds ?? []),
    ...graph.edges.flatMap((edge) => edge.factIds ?? []),
  ]);
  const coveredEntries = [...entryFactIds].filter((id) => graphFactIds.has(id));

  const allEvidence = [
    ...graph.nodes.flatMap((node) => node.evidence ?? []),
    ...graph.edges.flatMap((edge) => edge.evidence ?? []),
  ];
  const locatableEvidence = allEvidence.filter((evidence) => {
    if (!evidence.file) return false;
    if (evidence.startLine !== undefined && evidence.startLine < 1) return false;
    if (evidence.endLine !== undefined && evidence.startLine !== undefined && evidence.endLine < evidence.startLine) return false;
    return options.fileExists ? options.fileExists(evidence.file) : true;
  });

  const groundedItems = [...graph.nodes, ...graph.edges];
  const ungroundedItems = groundedItems.filter((item) =>
    item.inferred !== true && (item.evidence?.length ?? 0) === 0,
  );
  for (const item of ungroundedItems.slice(0, 20)) {
    issues.push({
      code: "UNGROUNDED_GRAPH_ITEM",
      disposition: "hard_fail",
      message: `确定性图谱项缺少证据：${item.id}`,
      ...(Object.hasOwn(item, "source") ? { edgeId: item.id } : { nodeId: item.id }),
    });
  }

  const factById = new Map(factIndex.facts.map((fact) => [fact.factId, fact]));
  // 架构投影边是由多条已验证事实聚合出的展示关系，不对应单一原始 Fact 端点。
  // 它们可以保留确定性证据，但不能参与逐边的原始方向一致性统计。
  const deterministicEdges = graph.edges.filter((edge) =>
    edge.inferred !== true && !edge.id.startsWith("architecture-projection:"),
  );
  const directionVerified = deterministicEdges.filter((edge) =>
    (edge.factIds ?? []).some((id) => {
      const fact = factById.get(id);
      return fact?.subject.id === edge.source && fact.object?.id === edge.target;
    }),
  );

  const edgeById = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const flow = (graph.views ?? []).reduce(
    (accumulator, view) => {
      const current = viewContinuity(view, edgeById);
      return { valid: accumulator.valid + current.valid, total: accumulator.total + current.total };
    },
    { valid: 0, total: 0 },
  );

  const fingerprint = graphFingerprint(graph);
  const stability = options.previousBaseGraph
    ? Number(fingerprint === graphFingerprint(options.previousBaseGraph))
    : 1;

  const definitions: Array<{
    id: QualityMetric["id"];
    label: string;
    numerator: number;
    denominator: number;
    value: number;
    failure: Exclude<QualityDisposition, "pass" | "warning">;
    lowerIsBetter?: boolean;
  }> = [
    {
      id: "declared_module_coverage",
      label: "声明模块覆盖率",
      numerator: coveredModules.length,
      denominator: declaredModuleIds.size,
      value: ratio(coveredModules.length, declaredModuleIds.size),
      failure: "hard_fail",
    },
    {
      id: "critical_entry_coverage",
      label: "关键入口覆盖率",
      numerator: coveredEntries.length,
      denominator: entryFactIds.size,
      value: ratio(coveredEntries.length, entryFactIds.size),
      failure: "retry",
    },
    {
      id: "locatable_evidence_rate",
      label: "证据可定位率",
      numerator: locatableEvidence.length,
      denominator: allEvidence.length,
      value: ratio(locatableEvidence.length, allEvidence.length),
      failure: "hard_fail",
    },
    {
      id: "ungrounded_fact_rate",
      label: "无证据事实比例",
      numerator: ungroundedItems.length,
      denominator: groundedItems.length,
      value: groundedItems.length === 0 ? 0 : ungroundedItems.length / groundedItems.length,
      failure: "hard_fail",
      lowerIsBetter: true,
    },
    {
      id: "deterministic_direction_rate",
      label: "确定性关系方向正确率",
      numerator: directionVerified.length,
      denominator: deterministicEdges.length,
      value: ratio(directionVerified.length, deterministicEdges.length),
      failure: "retry",
    },
    {
      id: "critical_flow_continuity",
      label: "关键流程连续率",
      numerator: flow.valid,
      denominator: flow.total,
      value: ratio(flow.valid, flow.total),
      failure: "retry",
    },
    {
      id: "deterministic_rerun_stability",
      label: "确定性重跑稳定率",
      numerator: stability,
      denominator: 1,
      value: stability,
      failure: "hard_fail",
    },
  ];

  const metrics: QualityMetric[] = definitions.map((definition) => {
    const target = targets[definition.id];
    const passed = definition.lowerIsBetter ? definition.value <= target : definition.value >= target;
    const disposition: QualityDisposition = passed ? "pass" : definition.failure;
    if (!passed) {
      issues.push({
        code: definition.id.toUpperCase(),
        disposition: definition.failure,
        message: `${definition.label} ${(definition.value * 100).toFixed(1)}%，门槛 ${(target * 100).toFixed(1)}%`,
      });
    }
    return { ...definition, target, disposition };
  });

  const unresolved = diagnostics.diagnostics.filter((diagnostic) => diagnostic.severity !== "info");
  if (unresolved.length > 0) {
    issues.push({
      code: "UNRESOLVED_DIAGNOSTICS",
      disposition: "warning",
      message: `${unresolved.length} 条解析诊断未解决，已保留在 diagnostics.json`,
    });
  }
  const disposition = worst([
    ...metrics.map((metric) => metric.disposition),
    ...issues.map((issue) => issue.disposition),
  ]);
  const retryScopes = [...new Set(issues.map((issue) => issue.moduleId).filter((id): id is string => Boolean(id)))].sort();

  return {
    schemaVersion: "1.0",
    repositoryId: factIndex.repositoryId,
    commitSha: factIndex.commitSha,
    createdAt: new Date().toISOString(),
    disposition,
    // retry 表示需要重新分析对应范围；在重试完成前不能切换正式 GraphVersion。
    publishable: disposition === "pass" || disposition === "warning",
    graphFingerprint: fingerprint,
    metrics,
    issues,
    retryScopes,
    unresolvedCount: unresolved.length,
  };
}
