import { edgeId, pendingLinkId } from "../domain/ids.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceEdge,
  type EvidenceNode,
  type EvidenceRelationType,
  type PendingLink,
} from "../domain/types.js";

export interface LinkCandidate {
  repositoryId: string;
  fromId: string;
  toId: string;
  relationType: EvidenceRelationType;
  basis: string;
  rawRef?: string;
}

export interface LinkResult {
  edges: EvidenceEdge[];
  pendingLinks: PendingLink[];
}

export function resolveLinks(nodes: EvidenceNode[], candidates: LinkCandidate[], now = new Date().toISOString()): LinkResult {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = new Map<string, EvidenceEdge>();
  const pendingLinks = new Map<string, PendingLink>();

  for (const candidate of candidates) {
    if (!nodeIds.has(candidate.fromId)) continue;
    if (!nodeIds.has(candidate.toId)) {
      const id = pendingLinkId(candidate.fromId, candidate.relationType, candidate.toId);
      pendingLinks.set(id, {
        id,
        repositoryId: candidate.repositoryId,
        fromId: candidate.fromId,
        expectedToId: candidate.toId,
        relationType: candidate.relationType,
        basis: candidate.basis,
        createdAt: now,
      });
      continue;
    }

    const id = edgeId(candidate.fromId, candidate.relationType, candidate.toId);
    edges.set(id, {
      id,
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      repositoryId: candidate.repositoryId,
      fromId: candidate.fromId,
      toId: candidate.toId,
      relationType: candidate.relationType,
      basis: candidate.basis,
      rawRef: candidate.rawRef,
      createdAt: now,
    });
  }

  return {
    edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
    pendingLinks: [...pendingLinks.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
}
