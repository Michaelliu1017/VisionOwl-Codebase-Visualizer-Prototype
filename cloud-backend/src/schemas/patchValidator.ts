import fs from "node:fs";
import path from "node:path";
import Ajv, { type ValidateFunction } from "ajv";
import type { Evidence, GraphDocument, GraphEdge, GraphNode, GraphView } from "../types";
import type { FactIndex, SymbolIndex } from "../scanner/v2/contracts";
import { stableHash } from "../scanner/v2/ids";

export type PatchOperationType =
  | "add_node"
  | "add_edge"
  | "replace_edge"
  | "suppress_edge"
  | "update_summary"
  | "set_architecture"
  | "add_view";

export interface ArchitectureDecision {
  role: "frontend" | "backend" | "worker" | "executor" | "data" | "shared" | "domain" | "external";
  importance: "primary" | "supporting" | "detail";
  visibleByDefault: boolean;
  rationale?: string;
  displayGroup?: "client" | "local-runtime" | "cloud-runtime" | "shared" | "external";
  groupLabel?: string;
}

export interface GraphPatchOperation {
  operationId: string;
  op: PatchOperationType;
  reason: string;
  evidence: Evidence[];
  confidence: number;
  node?: GraphNode;
  edge?: GraphEdge;
  edgeId?: string;
  nodeId?: string;
  summary?: string;
  architecture?: ArchitectureDecision;
  view?: GraphView;
}

export interface GraphPatchDocument {
  schemaVersion: "1.0";
  baseGraphVersion: string;
  repositoryId: string;
  commitSha: string;
  generator: string;
  skillVersion: string;
  operations: GraphPatchOperation[];
}

export interface RejectedPatchOperation {
  operationId: string;
  reason: string;
  operation: GraphPatchOperation;
}

export interface ConflictingPatchOperation extends RejectedPatchOperation {
  conflictingEdgeId: string;
}

export interface PatchValidationResult {
  ok: boolean;
  documentErrors: string[];
  accepted: GraphPatchOperation[];
  rejected: RejectedPatchOperation[];
  conflicts: ConflictingPatchOperation[];
}

type UnknownRecord = Record<string, unknown>;

function unknownRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

/**
 * Normalize two legacy aliases occasionally emitted by a model. This only
 * repairs field names; schema, evidence and conflict validation still decide
 * whether an operation can be accepted.
 */
export function normalizeGraphPatchAliases(value: unknown): unknown {
  const document = unknownRecord(value);
  if (!document || !Array.isArray(document.operations)) return value;
  const operations = document.operations.map((candidate) => {
    const operation = unknownRecord(candidate);
    if (!operation) return candidate;
    const normalized: UnknownRecord = { ...operation };
    if (typeof normalized.op !== "string" && typeof normalized.operation === "string") {
      normalized.op = normalized.operation;
    }
    delete normalized.operation;
    if (normalized.op === "update_summary" && typeof normalized.nodeId !== "string" && typeof normalized.targetId === "string") {
      normalized.nodeId = normalized.targetId;
    }
    delete normalized.targetId;
    return normalized;
  });
  return { ...document, operations };
}

function loadSchema(): object {
  const candidates = [
    path.join(__dirname, "graph-patch.schema.json"),
    path.join(__dirname, "..", "..", "src", "schemas", "graph-patch.schema.json"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, "utf8")) as object;
  }
  throw new Error("找不到 graph-patch.schema.json");
}

let validator: ValidateFunction | null = null;
function schemaValidator(): ValidateFunction {
  if (!validator) validator = new Ajv({ allErrors: true, strict: false }).compile(loadSchema());
  return validator;
}

export function baseGraphVersionFor(graph: GraphDocument): string {
  const nodeIds = graph.nodes.map((node) => node.id).sort().join("\n");
  const edgeIds = graph.edges.map((edge) => `${edge.id}:${edge.source}:${edge.target}:${edge.type}`).sort().join("\n");
  return `base-v2:${graph.commitSha}:${stableHash(nodeIds, edgeIds)}`;
}

function validateEvidence(
  evidence: Evidence[],
  opts: PatchValidationOptions,
): string | null {
  for (const item of evidence) {
    if (item.startLine !== undefined && item.endLine !== undefined && item.endLine < item.startLine) {
      return `证据行号倒置：${item.file}:${item.startLine}-${item.endLine}`;
    }
    if (opts.fileExists && !opts.fileExists(item.file)) return `证据文件不存在：${item.file}`;
    const referencedFact = item.factId
      ? opts.factIndex.facts.find((fact) => fact.factId === item.factId)
      : undefined;
    if (item.factId && !referencedFact) return `证据引用了不存在的 Fact：${item.factId}`;
    if (referencedFact && !referencedFact.evidence.some((factEvidence) =>
      factEvidence.file === item.file &&
      (item.startLine === undefined || factEvidence.startLine === item.startLine),
    )) {
      return `证据与 Fact 的源码位置不一致：${item.factId} @ ${item.file}:${item.startLine ?? "?"}`;
    }
    if (!referencedFact && item.symbol && !opts.symbolIndex.definitions.some((definition) =>
      definition.name === item.symbol && definition.file === item.file,
    )) {
      return `证据符号无法在 Symbol Index 定位：${item.symbol} @ ${item.file}`;
    }
  }
  return null;
}

export interface PatchValidationOptions {
  baseGraph: GraphDocument;
  factIndex: FactIndex;
  symbolIndex: SymbolIndex;
  fileExists?: (relativePath: string) => boolean;
  minimumConfidence?: number;
}

export function validateGraphPatch(
  input: unknown,
  opts: PatchValidationOptions,
): PatchValidationResult {
  const validate = schemaValidator();
  if (!validate(input)) {
    return {
      ok: false,
      documentErrors: (validate.errors ?? []).map((error) =>
        `schema ${error.instancePath || "/"} ${error.message ?? "非法"}`,
      ).slice(0, 30),
      accepted: [],
      rejected: [],
      conflicts: [],
    };
  }

  const patch = input as GraphPatchDocument;
  const documentErrors: string[] = [];
  if (patch.commitSha !== opts.baseGraph.commitSha) {
    documentErrors.push(`commit 不一致：Patch=${patch.commitSha} Base=${opts.baseGraph.commitSha}`);
  }
  if (patch.repositoryId !== opts.factIndex.repositoryId) {
    documentErrors.push(`repositoryId 不一致：Patch=${patch.repositoryId} Fact=${opts.factIndex.repositoryId}`);
  }
  const expectedBaseVersion = baseGraphVersionFor(opts.baseGraph);
  if (patch.baseGraphVersion !== expectedBaseVersion) {
    documentErrors.push(`baseGraphVersion 不一致：Patch=${patch.baseGraphVersion} Base=${expectedBaseVersion}`);
  }
  if (documentErrors.length > 0) {
    return { ok: false, documentErrors, accepted: [], rejected: [], conflicts: [] };
  }

  const nodeIds = new Set(opts.baseGraph.nodes.map((node) => node.id));
  const edgeById = new Map(opts.baseGraph.edges.map((edge) => [edge.id, edge]));
  const operationIds = new Set<string>();
  const accepted: GraphPatchOperation[] = [];
  const rejected: RejectedPatchOperation[] = [];
  const conflicts: ConflictingPatchOperation[] = [];
  const reject = (operation: GraphPatchOperation, reason: string): void => {
    rejected.push({ operationId: operation.operationId, reason, operation });
  };

  for (const operation of patch.operations) {
    if (operationIds.has(operation.operationId)) {
      reject(operation, "operationId 重复");
      continue;
    }
    operationIds.add(operation.operationId);
    if (operation.confidence < (opts.minimumConfidence ?? 0.65)) {
      reject(operation, `confidence ${operation.confidence} 低于门槛 ${opts.minimumConfidence ?? 0.65}`);
      continue;
    }
    const evidenceError = validateEvidence(operation.evidence, opts);
    if (evidenceError) {
      reject(operation, evidenceError);
      continue;
    }
    if (operation.op === "add_node") {
      if (!operation.node || nodeIds.has(operation.node.id)) {
        reject(operation, "add_node 缺少节点或节点已存在");
        continue;
      }
      if (operation.node.repositoryId !== patch.repositoryId) {
        reject(operation, `add_node 的 repositoryId 不一致：${operation.node.repositoryId ?? "缺失"}`);
        continue;
      }
      nodeIds.add(operation.node.id);
    } else if (operation.op === "add_edge") {
      if (!operation.edge || !nodeIds.has(operation.edge.source) || !nodeIds.has(operation.edge.target)) {
        reject(operation, "add_edge 缺少边或端点不存在");
        continue;
      }
      if (edgeById.has(operation.edge.id)) {
        reject(operation, `add_edge 的边 ID 已存在：${operation.edge.id}`);
        continue;
      }
      if (operation.edge.repositoryId !== patch.repositoryId) {
        reject(operation, `add_edge 的 repositoryId 不一致：${operation.edge.repositoryId ?? "缺失"}`);
        continue;
      }
      const conflict = [...edgeById.values()].find((edge) =>
        edge.source === operation.edge!.source && edge.target === operation.edge!.target && edge.type !== operation.edge!.type,
      );
      if (conflict) {
        conflicts.push({
          operationId: operation.operationId,
          reason: `与已有边 ${conflict.id} 类型冲突，应使用 replace_edge`,
          operation,
          conflictingEdgeId: conflict.id,
        });
        continue;
      }
      edgeById.set(operation.edge.id, operation.edge);
    } else if (operation.op === "replace_edge" || operation.op === "suppress_edge") {
      if (!operation.edgeId || !edgeById.has(operation.edgeId)) {
        reject(operation, `${operation.op} 指向的边不存在`);
        continue;
      }
      if (operation.op === "replace_edge") {
        if (!operation.edge || !nodeIds.has(operation.edge.source) || !nodeIds.has(operation.edge.target)) {
          reject(operation, "replace_edge 的新边或端点不存在");
          continue;
        }
        if (operation.edge.repositoryId !== patch.repositoryId) {
          reject(operation, `replace_edge 的 repositoryId 不一致：${operation.edge.repositoryId ?? "缺失"}`);
          continue;
        }
        edgeById.set(operation.edgeId, operation.edge);
      } else {
        edgeById.delete(operation.edgeId);
      }
    } else if (operation.op === "update_summary") {
      if (!operation.nodeId || !nodeIds.has(operation.nodeId) || !operation.summary?.trim()) {
        reject(operation, "update_summary 的节点不存在或摘要为空");
        continue;
      }
    } else if (operation.op === "set_architecture") {
      const node = operation.nodeId ? opts.baseGraph.nodes.find((item) => item.id === operation.nodeId) : null;
      if (!node || !operation.architecture) {
        reject(operation, "set_architecture 的节点不存在或缺少架构判断");
        continue;
      }
      if (node.kind !== "module" && node.kind !== "submodule") {
        reject(operation, `set_architecture 只能作用于代码模块，当前 kind=${node.kind}`);
        continue;
      }
    } else if (operation.op === "add_view") {
      if (!operation.view) {
        reject(operation, "add_view 缺少 view");
        continue;
      }
      const missingNode = operation.view.nodeIds.find((id) => !nodeIds.has(id));
      const missingEdge = operation.view.edgeIds.find((id) => !edgeById.has(id));
      if (missingNode || missingEdge) {
        reject(operation, `add_view 存在无效引用：${missingNode ?? missingEdge}`);
        continue;
      }
    }
    accepted.push(operation);
  }

  return {
    ok: documentErrors.length === 0,
    documentErrors,
    accepted,
    rejected,
    conflicts,
  };
}

export function emptyGraphPatch(graph: GraphDocument, repositoryId: string): GraphPatchDocument {
  return {
    schemaVersion: "1.0",
    baseGraphVersion: baseGraphVersionFor(graph),
    repositoryId,
    commitSha: graph.commitSha,
    generator: "visionowl-scanner",
    skillVersion: "none",
    operations: [],
  };
}
