import { canonicalJson } from "../domain/canonicalJson.js";
import { sha256 } from "../domain/ids.js";
import type { EvidenceEdge, EvidenceNode, EvidenceSnapshot, PendingLink } from "../domain/types.js";

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  evidenceId?: string;
}

export interface ValidationReport {
  valid: boolean;
  issues: ValidationIssue[];
  counts: {
    nodes: number;
    edges: number;
    pendingLinks: number;
  };
}

export function validateEvidenceGraph(
  nodes: EvidenceNode[],
  edges: EvidenceEdge[],
  pendingLinks: PendingLink[],
): ValidationReport {
  const issues: ValidationIssue[] = [];
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();

  for (const node of nodes) {
    if (nodeIds.has(node.id)) {
      issues.push({ severity: "error", code: "DUPLICATE_NODE", message: `duplicate node ${node.id}`, evidenceId: node.id });
    }
    nodeIds.add(node.id);
    if (node.schemaVersion !== "evidence.v1") {
      issues.push({ severity: "error", code: "SCHEMA_VERSION", message: `unsupported schema ${node.schemaVersion}`, evidenceId: node.id });
    }
    if (!node.rawRef) {
      issues.push({ severity: "error", code: "MISSING_RAW_REF", message: "node has no rawRef", evidenceId: node.id });
    }
    if (!/^https:\/\//.test(node.sourceUrl)) {
      issues.push({ severity: "error", code: "INVALID_SOURCE_URL", message: `invalid sourceUrl ${node.sourceUrl}`, evidenceId: node.id });
    }
    const { checksum: ignored, ...nodeWithoutChecksum } = node;
    void ignored;
    const expectedChecksum = sha256(canonicalJson(nodeWithoutChecksum));
    if (expectedChecksum !== node.checksum) {
      issues.push({ severity: "error", code: "CHECKSUM_MISMATCH", message: "node checksum does not match content", evidenceId: node.id });
    }
  }

  for (const edge of edges) {
    if (edgeIds.has(edge.id)) {
      issues.push({ severity: "error", code: "DUPLICATE_EDGE", message: `duplicate edge ${edge.id}`, evidenceId: edge.id });
    }
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.fromId)) {
      issues.push({ severity: "error", code: "MISSING_EDGE_SOURCE", message: `missing edge source ${edge.fromId}`, evidenceId: edge.id });
    }
    if (!nodeIds.has(edge.toId)) {
      issues.push({ severity: "error", code: "MISSING_EDGE_TARGET", message: `missing edge target ${edge.toId}`, evidenceId: edge.id });
    }
  }

  for (const pending of pendingLinks) {
    if (!nodeIds.has(pending.fromId)) {
      issues.push({
        severity: "error",
        code: "MISSING_PENDING_SOURCE",
        message: `pending link source ${pending.fromId} does not exist`,
        evidenceId: pending.id,
      });
    } else {
      issues.push({
        severity: "warning",
        code: "PENDING_LINK",
        message: `${pending.relationType} waits for ${pending.expectedToId}`,
        evidenceId: pending.id,
      });
    }
  }

  return {
    valid: !issues.some((issue) => issue.severity === "error"),
    issues,
    counts: { nodes: nodes.length, edges: edges.length, pendingLinks: pendingLinks.length },
  };
}

export function validateSnapshot(snapshot: EvidenceSnapshot): ValidationReport {
  return validateEvidenceGraph(snapshot.nodes, snapshot.edges, snapshot.pendingLinks);
}
