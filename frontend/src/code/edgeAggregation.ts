import type { GraphRelation } from "@visionowl/contracts";

export type DomainRelationAggregate = {
  id: string;
  sourceDomainId: string;
  targetDomainId: string;
  count: number;
  types: string[];
  labels: string[];
  relationIds: string[];
};

type MutableAggregate = Omit<
  DomainRelationAggregate,
  "types" | "labels"
> & {
  types: Set<string>;
  labels: Set<string>;
};

function aggregateKey(sourceDomainId: string, targetDomainId: string) {
  return `${sourceDomainId.length}:${sourceDomainId}\u0000${targetDomainId}`;
}

export function aggregateRelationsByDomain(
  relations: GraphRelation[],
  entityDomain: ReadonlyMap<string, string>,
): DomainRelationAggregate[] {
  const aggregates = new Map<string, MutableAggregate>();

  for (const relation of relations) {
    if (relation.type === "contains") continue;
    const sourceDomainId = entityDomain.get(relation.source);
    const targetDomainId = entityDomain.get(relation.target);
    if (
      !sourceDomainId ||
      !targetDomainId ||
      sourceDomainId === targetDomainId
    ) {
      continue;
    }

    const key = aggregateKey(sourceDomainId, targetDomainId);
    const current = aggregates.get(key);
    if (current) {
      current.count += 1;
      current.types.add(relation.type);
      if (relation.label) current.labels.add(relation.label);
      current.relationIds.push(relation.id);
      continue;
    }

    aggregates.set(key, {
      id: `visual:domain-edge:${key}`,
      sourceDomainId,
      targetDomainId,
      count: 1,
      types: new Set([relation.type]),
      labels: new Set(relation.label ? [relation.label] : []),
      relationIds: [relation.id],
    });
  }

  return [...aggregates.values()]
    .map((aggregate) => ({
      ...aggregate,
      types: [...aggregate.types].sort(),
      labels: [...aggregate.labels].sort(),
    }))
    .sort(
      (left, right) =>
        left.sourceDomainId.localeCompare(right.sourceDomainId) ||
        left.targetDomainId.localeCompare(right.targetDomainId),
    );
}

export function aggregateLabel(aggregate: DomainRelationAggregate) {
  const relationKinds =
    aggregate.labels.length > 0 ? aggregate.labels : aggregate.types;
  const kindLabel =
    relationKinds.length <= 2
      ? relationKinds.join(" / ")
      : `${relationKinds.slice(0, 2).join(" / ")} +${relationKinds.length - 2}`;
  return `${aggregate.count} · ${kindLabel || "relations"}`;
}
