import type { GraphRelation } from "@visionowl/contracts";

const MAX_INTERACTIONS = 9;
const MAX_UPSTREAM_DEPTH = 3;

function relationPriority(left: GraphRelation, right: GraphRelation) {
  const evidenceDifference = right.evidence.length - left.evidence.length;
  if (evidenceDifference !== 0) return evidenceDifference;
  const referenceDifference =
    Number(right.metadata.references ?? 0) - Number(left.metadata.references ?? 0);
  if (referenceDifference !== 0) return referenceDifference;
  return left.id.localeCompare(right.id);
}

export function sourceBackedRelations(relations: GraphRelation[]) {
  return relations
    .filter(
      (relation) =>
        relation.type !== "contains" &&
        relation.source !== relation.target &&
        relation.evidence.length > 0,
    )
    .sort(relationPriority);
}

export function buildInteractionPath(
  relations: GraphRelation[],
  selectedId?: string,
) {
  if (!selectedId) return [];

  const candidates = sourceBackedRelations(relations);
  const incoming = new Map<string, GraphRelation[]>();
  const outgoing = new Map<string, GraphRelation[]>();

  for (const relation of candidates) {
    incoming.set(relation.target, [
      ...(incoming.get(relation.target) ?? []),
      relation,
    ]);
    outgoing.set(relation.source, [
      ...(outgoing.get(relation.source) ?? []),
      relation,
    ]);
  }
  for (const values of incoming.values()) values.sort(relationPriority);
  for (const values of outgoing.values()) values.sort(relationPriority);

  const result: GraphRelation[] = [];
  const visitedNodes = new Set([selectedId]);
  const visitedRelations = new Set<string>();

  let upstreamNode = selectedId;
  for (let depth = 0; depth < MAX_UPSTREAM_DEPTH; depth += 1) {
    const relation = (incoming.get(upstreamNode) ?? []).find(
      (item) =>
        !visitedRelations.has(item.id) && !visitedNodes.has(item.source),
    );
    if (!relation) break;
    result.unshift(relation);
    visitedRelations.add(relation.id);
    visitedNodes.add(relation.source);
    upstreamNode = relation.source;
  }

  const queue = [selectedId];
  while (queue.length > 0 && result.length < MAX_INTERACTIONS) {
    const source = queue.shift();
    if (!source) continue;
    for (const relation of outgoing.get(source) ?? []) {
      if (result.length >= MAX_INTERACTIONS) break;
      if (visitedRelations.has(relation.id)) continue;
      visitedRelations.add(relation.id);
      result.push(relation);
      if (!visitedNodes.has(relation.target)) {
        visitedNodes.add(relation.target);
        queue.push(relation.target);
      }
    }
  }

  return result;
}
