import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  Controls,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  BookOpen,
  Box,
  ChevronDown,
  ChevronRight,
  Database,
  FileCode2,
  Globe2,
  Layers3,
  MessageSquareText,
  Package,
} from "lucide-react";
import type {
  DocumentBinding,
  EntityContext,
  GraphEntity,
  GraphRelation,
} from "@visionowl/contracts";
import type { CodeViewMode } from "./CodeModeSwitch";
import {
  CODE_NODE_HEIGHT,
  CODE_NODE_WIDTH,
  createFallbackCodeGraphLayout,
  layoutCodeGraph,
  type CodeDomainLayout,
} from "./layout";
import {
  aggregateLabel,
  aggregateRelationsByDomain,
  type DomainRelationAggregate,
} from "./edgeAggregation";
import {
  SimulationEdge,
  type SimulationEdgeData,
} from "./SimulationEdge";
import { ClarityEdge, type ClarityEdgeData } from "./ClarityEdge";

type CodeNodeData = {
  entity: GraphEntity;
  related: boolean;
  dimmed: boolean;
  executionStep?: number;
  simulationState?: "queued" | "active" | "complete";
};

type ContextData = {
  kind: "document" | "annotation";
  anchorId: string;
  title: string;
  detail: string;
  url?: string;
};

type DomainNodeData = {
  domain: CodeDomainLayout;
  onSelect: (domain: CodeDomainLayout) => void;
  onToggle: (domain: CodeDomainLayout) => void;
};

type DisplayRelation = {
  id: string;
  source: string;
  target: string;
  label: string;
  relationIds: string[];
  bidirectional: boolean;
  reciprocal: boolean;
  lane: number;
  aggregate: boolean;
  execution: boolean;
};

type GraphPoint = {
  x: number;
  y: number;
};

type GraphRect = GraphPoint & {
  width: number;
  height: number;
};

type GraphNodeGeometry = GraphRect;

function iconFor(entity: GraphEntity) {
  if (
    entity.category === "data" ||
    entity.kind.includes("database") ||
    entity.kind.includes("redis") ||
    entity.kind.includes("logstore")
  ) {
    return Database;
  }
  if (entity.category === "external" || entity.kind.includes("endpoint")) {
    return Globe2;
  }
  if (entity.kind.includes("file")) return FileCode2;
  if (entity.kind.includes("package") || entity.kind.includes("module")) return Package;
  return Box;
}

function subtitleFor(entity: GraphEntity) {
  const explicit =
    typeof entity.metadata.subtitle === "string"
      ? entity.metadata.subtitle.trim()
      : "";
  if (explicit) return explicit;
  const summary = entity.summary?.trim();
  if (summary) {
    const firstSentence = summary.split(/[。！？\n]/, 1)[0].trim();
    return firstSentence || summary;
  }
  return entity.kind;
}

const CodeNode = memo(({ data, selected }: NodeProps<Node<CodeNodeData>>) => {
  const Icon = iconFor(data.entity);
  const subtitle = subtitleFor(data.entity);
  return (
    <div
      className={[
        "vision-code-node",
        selected ? "is-selected" : "",
        data.related ? "is-related" : "",
        data.dimmed ? "is-dimmed" : "",
        data.entity.metadata.execution === true ? "is-execution" : "",
        `is-category-${data.entity.category}`,
        data.simulationState ? `is-simulation-${data.simulationState}` : "",
      ].join(" ")}
    >
      <Handle
        id="target-left"
        className="vision-code-node__handle"
        type="target"
        position={Position.Left}
      />
      <Handle
        id="source-left"
        className="vision-code-node__handle"
        type="source"
        position={Position.Left}
      />
      <Handle
        id="target-top"
        className="vision-code-node__handle"
        type="target"
        position={Position.Top}
      />
      <Handle
        id="source-top"
        className="vision-code-node__handle"
        type="source"
        position={Position.Top}
      />
      <span className="vision-code-node__icon">
        <Icon size={17} />
      </span>
      <span className="vision-code-node__copy">
        <strong>{data.entity.name}</strong>
        <small title={subtitle}>{subtitle}</small>
      </span>
      {data.executionStep !== undefined && (
        <span className="vision-code-node__step">
          {String(data.executionStep + 1).padStart(2, "0")}
        </span>
      )}
      <Handle
        id="target-right"
        className="vision-code-node__handle"
        type="target"
        position={Position.Right}
      />
      <Handle
        id="source-right"
        className="vision-code-node__handle"
        type="source"
        position={Position.Right}
      />
      <Handle
        id="target-bottom"
        className="vision-code-node__handle"
        type="target"
        position={Position.Bottom}
      />
      <Handle
        id="source-bottom"
        className="vision-code-node__handle"
        type="source"
        position={Position.Bottom}
      />
    </div>
  );
});
CodeNode.displayName = "CodeNode";

const DomainNode = memo(
  ({ data, selected }: NodeProps<Node<DomainNodeData>>) => {
    const Icon = data.domain.infrastructure ? Database : Layers3;
    return (
      <section
        className={[
          "vision-code-domain",
          data.domain.collapsed ? "is-collapsed" : "",
          data.domain.execution ? "is-execution" : "",
          data.domain.infrastructure ? "is-infrastructure" : "",
          selected ? "is-selected" : "",
        ].join(" ")}
        aria-label={`${data.domain.label} 领域`}
        tabIndex={0}
        onClick={(event) => {
          event.stopPropagation();
          data.onSelect(data.domain);
        }}
        onKeyDown={(event) => {
          if (
            event.target === event.currentTarget &&
            (event.key === "Enter" || event.key === " ")
          ) {
            event.preventDefault();
            data.onSelect(data.domain);
          }
        }}
      >
    <Handle
      id="target-left"
      className="vision-code-domain__handle"
      type="target"
      position={Position.Left}
    />
    <Handle
      id="source-left"
      className="vision-code-domain__handle"
      type="source"
      position={Position.Left}
    />
    <Handle
      id="target-top"
      className="vision-code-domain__handle"
      type="target"
      position={Position.Top}
    />
    <Handle
      id="source-top"
      className="vision-code-domain__handle"
      type="source"
      position={Position.Top}
    />
    <header className="vision-code-domain__header">
      <span className="vision-code-domain__icon">
        <Icon size={15} />
      </span>
      <span className="vision-code-domain__copy">
        <small>
          {data.domain.execution
            ? "EXECUTION LANE"
            : data.domain.infrastructure
              ? "INFRASTRUCTURE"
              : "CODE DOMAIN"}
        </small>
        <strong>{data.domain.label}</strong>
      </span>
      <span className="vision-code-domain__count">
        {data.domain.entityIds.length}
      </span>
      {!data.domain.execution && (
        <button
          className="vision-code-domain__toggle nodrag nopan"
          type="button"
          title={data.domain.collapsed ? "展开领域模块" : "收起领域模块"}
          aria-label={data.domain.collapsed ? "展开领域模块" : "收起领域模块"}
          aria-expanded={!data.domain.collapsed}
          onClick={(event) => {
            event.stopPropagation();
            data.onToggle(data.domain);
          }}
        >
          {data.domain.collapsed ? (
            <ChevronRight size={15} />
          ) : (
            <ChevronDown size={15} />
          )}
        </button>
      )}
    </header>
    <Handle
      id="target-right"
      className="vision-code-domain__handle"
      type="target"
      position={Position.Right}
    />
    <Handle
      id="source-right"
      className="vision-code-domain__handle"
      type="source"
      position={Position.Right}
    />
    <Handle
      id="target-bottom"
      className="vision-code-domain__handle"
      type="target"
      position={Position.Bottom}
    />
    <Handle
      id="source-bottom"
      className="vision-code-domain__handle"
      type="source"
      position={Position.Bottom}
    />
      </section>
    );
  },
);
DomainNode.displayName = "DomainNode";

const ContextNode = memo(({ data }: NodeProps<Node<ContextData>>) => {
  const Icon = data.kind === "document" ? BookOpen : MessageSquareText;
  const handles = (
    <>
      <Handle
        id="context-left"
        className="vision-context-card__handle"
        type="target"
        position={Position.Left}
      />
      <Handle
        id="context-right"
        className="vision-context-card__handle"
        type="source"
        position={Position.Right}
      />
    </>
  );
  const content = (
    <>
      <Icon size={15} />
      <span>
        <small>{data.kind === "document" ? "关联文档" : "团队批注"}</small>
        <strong>{data.title}</strong>
        <p>{data.detail}</p>
      </span>
    </>
  );
  return data.url ? (
    <a
      className={`vision-context-card is-${data.kind}`}
      href={data.url}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => event.stopPropagation()}
    >
      {handles}
      {content}
    </a>
  ) : (
    <article className={`vision-context-card is-${data.kind}`}>
      {handles}
      {content}
    </article>
  );
});
ContextNode.displayName = "ContextNode";

const nodeTypes = {
  code: CodeNode,
  context: ContextNode,
  domain: DomainNode,
} satisfies NodeTypes;

const edgeTypes = {
  clarity: ClarityEdge,
  simulation: SimulationEdge,
};

function relationHandles(
  sourceGeometry: GraphNodeGeometry,
  targetGeometry: GraphNodeGeometry,
) {
  const sourceCenter = {
    x: sourceGeometry.x + sourceGeometry.width / 2,
    y: sourceGeometry.y + sourceGeometry.height / 2,
  };
  const targetCenter = {
    x: targetGeometry.x + targetGeometry.width / 2,
    y: targetGeometry.y + targetGeometry.height / 2,
  };
  const deltaX = targetCenter.x - sourceCenter.x;
  const deltaY = targetCenter.y - sourceCenter.y;

  if (Math.abs(deltaX) >= Math.abs(deltaY)) {
    return deltaX >= 0
      ? { sourceHandle: "source-right", targetHandle: "target-left" }
      : { sourceHandle: "source-left", targetHandle: "target-right" };
  }
  return deltaY >= 0
    ? { sourceHandle: "source-bottom", targetHandle: "target-top" }
    : { sourceHandle: "source-top", targetHandle: "target-bottom" };
}

function handlePoint(
  geometry: GraphNodeGeometry,
  handle: string,
): GraphPoint {
  if (handle.endsWith("left")) {
    return { x: geometry.x, y: geometry.y + geometry.height / 2 };
  }
  if (handle.endsWith("right")) {
    return {
      x: geometry.x + geometry.width,
      y: geometry.y + geometry.height / 2,
    };
  }
  if (handle.endsWith("top")) {
    return { x: geometry.x + geometry.width / 2, y: geometry.y };
  }
  return {
    x: geometry.x + geometry.width / 2,
    y: geometry.y + geometry.height,
  };
}

function handleDirection(handle: string): GraphPoint {
  if (handle.endsWith("left")) return { x: -1, y: 0 };
  if (handle.endsWith("right")) return { x: 1, y: 0 };
  if (handle.endsWith("top")) return { x: 0, y: -1 };
  return { x: 0, y: 1 };
}

function rectsOverlap(left: GraphRect, right: GraphRect) {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

function placeRelationLabel({
  relation,
  handles,
  geometries,
  obstacles,
  occupied,
}: {
  relation: DisplayRelation;
  handles: { sourceHandle: string; targetHandle: string };
  geometries: Map<string, GraphNodeGeometry>;
  obstacles: GraphRect[];
  occupied: GraphRect[];
}) {
  const fallbackGeometry = {
    x: 0,
    y: 0,
    width: CODE_NODE_WIDTH,
    height: CODE_NODE_HEIGHT,
  };
  const source = handlePoint(
    geometries.get(relation.source) ?? fallbackGeometry,
    handles.sourceHandle,
  );
  const target = handlePoint(
    geometries.get(relation.target) ?? fallbackGeometry,
    handles.targetHandle,
  );
  const sourceDirection = handleDirection(handles.sourceHandle);
  const targetDirection = handleDirection(handles.targetHandle);
  const vertical = Math.abs(target.y - source.y) > Math.abs(target.x - source.x);
  const lane = relation.lane;
  const maxLabelWidth = relation.execution ? 190 : 144;
  const estimatedTextWidth = Array.from(relation.label).length * 7.2 + 18;
  const width = Math.min(maxLabelWidth, Math.max(50, estimatedTextWidth));
  const lineCount = Math.max(1, Math.ceil(estimatedTextWidth / maxLabelWidth));
  const height = Math.min(58, Math.max(26, 14 + lineCount * 13));
  const midpoint = {
    x:
      (source.x + target.x) / 2 +
      (vertical ? (lane === 0 ? 20 : lane * 68) : 0),
    y: (source.y + target.y) / 2 + (vertical ? 0 : lane * 40),
  };
  const channelDistance =
    (vertical ? height : width) / 2 + (relation.execution ? 34 : 26);
  const sourceChannelDistance = Math.max(
    sourceDirection.x === 0 ? 52 : 84,
    channelDistance,
  );
  const targetChannelDistance = Math.max(
    targetDirection.x === 0 ? 52 : 84,
    channelDistance,
  );
  const sourceChannel = {
    x: source.x + sourceDirection.x * sourceChannelDistance,
    y: source.y + sourceDirection.y * sourceChannelDistance,
  };
  const targetChannel = {
    x: target.x + targetDirection.x * targetChannelDistance,
    y: target.y + targetDirection.y * targetChannelDistance,
  };
  const perpendicular = vertical ? { x: 1, y: 0 } : { x: 0, y: 1 };
  const clearanceStep =
    (vertical ? width : height) / 2 + (relation.execution ? 28 : 22);
  const offsets = [
    0,
    lane * 42,
    -clearanceStep,
    clearanceStep,
    -clearanceStep * 2,
    clearanceStep * 2,
    -clearanceStep * 3,
    clearanceStep * 3,
  ].filter((value, index, values) => values.indexOf(value) === index);
  const candidates = [midpoint, sourceChannel, targetChannel].flatMap(
    (anchor) =>
      offsets.map((offset) => ({
        x: anchor.x + perpendicular.x * offset,
        y: anchor.y + perpendicular.y * offset,
      })),
  );
  let best:
    | { point: GraphPoint; rect: GraphRect; score: number }
    | undefined;
  for (const point of candidates) {
    const rect = {
      x: point.x - width / 2,
      y: point.y - height / 2,
      width,
      height,
    };
    const nodeCollisions = obstacles.filter((item) =>
      rectsOverlap(rect, item),
    ).length;
    const labelCollisions = occupied.filter((item) =>
      rectsOverlap(rect, item),
    ).length;
    const score =
      nodeCollisions * 10_000 +
      labelCollisions * 180 +
      Math.hypot(point.x - midpoint.x, point.y - midpoint.y) * 0.01;
    if (!best || score < best.score) best = { point, rect, score };
    if (score === 0) break;
  }
  const chosen = best ?? {
    point: midpoint,
    rect: {
      x: midpoint.x - width / 2,
      y: midpoint.y - height / 2,
      width,
      height,
    },
  };
  occupied.push(chosen.rect);
  return chosen.point;
}

function orderedEndpoints(
  left: string,
  right: string,
  positions: Map<string, { x: number; y: number }>,
) {
  const leftPosition = positions.get(left) ?? { x: 0, y: 0 };
  const rightPosition = positions.get(right) ?? { x: 0, y: 0 };
  if (
    leftPosition.x < rightPosition.x ||
    (leftPosition.x === rightPosition.x && leftPosition.y <= rightPosition.y)
  ) {
    return [left, right] as const;
  }
  return [right, left] as const;
}

function compactExactRelations(
  relations: GraphRelation[],
  positions: Map<string, GraphPoint>,
): DisplayRelation[] {
  const groups = new Map<string, GraphRelation[]>();
  for (const relation of relations) {
    const key = [relation.source, relation.target].sort().join("\u0000");
    groups.set(key, [...(groups.get(key) ?? []), relation]);
  }

  return [...groups.values()].flatMap((group): DisplayRelation[] => {
    const first = group[0];
    const hasReverse = group.some(
      (relation) =>
        relation.source === first.target && relation.target === first.source,
    );
    if (!hasReverse) {
      return group.map((relation) => ({
        id: relation.id,
        source: relation.source,
        target: relation.target,
        label: relation.label,
        relationIds: [relation.id],
        bidirectional: false,
        reciprocal: false,
        lane: 0,
        aggregate: false,
        execution: relation.metadata.execution === true,
      }));
    }

    const [source, target] = orderedEndpoints(
      first.source,
      first.target,
      positions,
    );
    const labels = [
      ...new Set(group.map((relation) => relation.label).filter(Boolean)),
    ];
    return [
      {
        id: `visual:bidirectional:${[source, target].sort().join(":")}`,
        source,
        target,
        label:
          labels.length === 1
            ? `${labels[0]} · 双向`
            : `${labels.join(" / ")} · 双向`,
        relationIds: group.map((relation) => relation.id),
        bidirectional: true,
        reciprocal: true,
        lane: 0,
        aggregate: false,
        execution: group.some(
          (relation) => relation.metadata.execution === true,
        ),
      },
    ];
  });
}

function directedExactRelations(
  relations: GraphRelation[],
  positions: Map<string, GraphPoint>,
): DisplayRelation[] {
  const directedGroups = new Map<string, GraphRelation[]>();
  for (const relation of relations) {
    const key = `${relation.source}\u0000${relation.target}`;
    directedGroups.set(key, [
      ...(directedGroups.get(key) ?? []),
      relation,
    ]);
  }

  return [...directedGroups.values()].map((group): DisplayRelation => {
    const first = group[0];
    const labels = [
      ...new Set(group.map((relation) => relation.label).filter(Boolean)),
    ];
    const [firstEndpoint] = orderedEndpoints(
      first.source,
      first.target,
      positions,
    );
    const reverseExists = relations.some(
      (relation) =>
        relation.source === first.target &&
        relation.target === first.source,
    );
    return {
      id:
        group.length === 1
          ? first.id
          : `visual:directed:${first.source}:${first.target}`,
      source: first.source,
      target: first.target,
      label: labels.join(" / "),
      relationIds: group.map((relation) => relation.id),
      bidirectional: false,
      reciprocal: reverseExists,
      lane: reverseExists ? (first.source === firstEndpoint ? -1 : 1) : 0,
      aggregate: false,
      execution: group.some(
        (relation) => relation.metadata.execution === true,
      ),
    };
  });
}

function combinedAggregateLabel(aggregates: DomainRelationAggregate[]) {
  const count = aggregates.reduce(
    (sum, aggregate) => sum + aggregate.count,
    0,
  );
  const labels = [
    ...new Set(
      aggregates.flatMap((aggregate) =>
        aggregate.labels.length > 0 ? aggregate.labels : aggregate.types,
      ),
    ),
  ].sort();
  const summary =
    labels.length <= 2
      ? labels.join(" / ")
      : `${labels.slice(0, 2).join(" / ")} +${labels.length - 2}`;
  return `${count} · ${summary || "relations"}`;
}

function domainAggregateRelations(
  relations: GraphRelation[],
  entityDomain: ReadonlyMap<string, string>,
  positions: Map<string, GraphPoint>,
  excludedDomainIds: ReadonlySet<string> = new Set(),
): DisplayRelation[] {
  const aggregates = aggregateRelationsByDomain(relations, entityDomain).filter(
    (aggregate) =>
      !excludedDomainIds.has(aggregate.sourceDomainId) &&
      !excludedDomainIds.has(aggregate.targetDomainId),
  );
  const groups = new Map<string, DomainRelationAggregate[]>();
  for (const aggregate of aggregates) {
    const key = [
      aggregate.sourceDomainId,
      aggregate.targetDomainId,
    ]
      .sort()
      .join("\u0000");
    groups.set(key, [...(groups.get(key) ?? []), aggregate]);
  }

  return [...groups.values()].map((group): DisplayRelation => {
    const first = group[0];
    const reverse = group.find(
      (candidate) =>
        candidate.sourceDomainId === first.targetDomainId &&
        candidate.targetDomainId === first.sourceDomainId,
    );
    if (!reverse) {
      return {
        id: first.id,
        source: first.sourceDomainId,
        target: first.targetDomainId,
        label: aggregateLabel(first),
        relationIds: first.relationIds,
        bidirectional: false,
        reciprocal: false,
        lane: 0,
        aggregate: true,
        execution: false,
      };
    }

    const [source, target] = orderedEndpoints(
      first.sourceDomainId,
      first.targetDomainId,
      positions,
    );
    return {
      id: `visual:domain-bidirectional:${source}:${target}`,
      source,
      target,
      label: `${combinedAggregateLabel(group)} · 双向`,
      relationIds: group.flatMap((aggregate) => aggregate.relationIds),
      bidirectional: true,
      reciprocal: true,
      lane: 0,
      aggregate: true,
      execution: false,
    };
  });
}

function collapsedEndpointRelations(
  relations: GraphRelation[],
  entityDomain: ReadonlyMap<string, string>,
  visibleEntityIds: ReadonlySet<string>,
  positions: Map<string, GraphPoint>,
): DisplayRelation[] {
  const projectedRelations: GraphRelation[] = [];
  const projectedEndpoints = new Map<string, string>();

  for (const relation of relations) {
    const source = visibleEntityIds.has(relation.source)
      ? relation.source
      : entityDomain.get(relation.source);
    const target = visibleEntityIds.has(relation.target)
      ? relation.target
      : entityDomain.get(relation.target);

    if (!source || !target || source === target) continue;
    if (source === relation.source && target === relation.target) continue;

    projectedRelations.push({
      ...relation,
      source,
      target,
    });
    projectedEndpoints.set(source, source);
    projectedEndpoints.set(target, target);
  }

  return domainAggregateRelations(
    projectedRelations,
    projectedEndpoints,
    positions,
  ).map((relation) => ({
    ...relation,
    id: `visual:collapsed:${relation.id}`,
  }));
}

function displayRelations({
  relations,
  mode,
  positions,
  entityDomain,
  visibleEntityIds,
  pathRelationIds,
  selectedId,
}: {
  relations: GraphRelation[];
  mode: CodeViewMode;
  positions: Map<string, GraphPoint>;
  entityDomain: ReadonlyMap<string, string>;
  visibleEntityIds: ReadonlySet<string>;
  pathRelationIds: ReadonlySet<string>;
  selectedId?: string;
}) {
  const visibleRelations = relations.filter(
    (relation) =>
      visibleEntityIds.has(relation.source) &&
      visibleEntityIds.has(relation.target),
  );

  if (mode === "simulation" && pathRelationIds.size > 0) {
    const pathRelations = visibleRelations.filter((relation) =>
      pathRelationIds.has(relation.id),
    );
    const pathRelationsAll = relations.filter((relation) =>
      pathRelationIds.has(relation.id),
    );
    const backgroundAll = relations.filter(
      (relation) => !pathRelationIds.has(relation.id),
    );
    const background = visibleRelations.filter(
      (relation) => !pathRelationIds.has(relation.id),
    );
    return [
      ...collapsedEndpointRelations(
        backgroundAll,
        entityDomain,
        visibleEntityIds,
        positions,
      ),
      ...compactExactRelations(background, positions),
      ...collapsedEndpointRelations(
        pathRelationsAll,
        entityDomain,
        visibleEntityIds,
        positions,
      ),
      ...directedExactRelations(pathRelations, positions),
    ];
  }

  if (selectedId) {
    const incidentRelations = visibleRelations.filter(
      (relation) =>
        relation.source === selectedId || relation.target === selectedId,
    );
    const incidentRelationsAll = relations.filter(
      (relation) =>
        relation.source === selectedId || relation.target === selectedId,
    );
    const incidentIds = new Set(
      incidentRelationsAll.map((relation) => relation.id),
    );
    const backgroundAll = relations.filter(
      (relation) => !incidentIds.has(relation.id),
    );
    const background = visibleRelations.filter(
      (relation) =>
        !incidentIds.has(relation.id) &&
        entityDomain.get(relation.source) ===
          entityDomain.get(relation.target),
    );
    const selectedDomainId = entityDomain.get(selectedId);
    return [
      ...domainAggregateRelations(
        backgroundAll,
        entityDomain,
        positions,
        selectedDomainId ? new Set([selectedDomainId]) : new Set(),
      ),
      ...compactExactRelations(background, positions),
      ...collapsedEndpointRelations(
        incidentRelationsAll,
        entityDomain,
        visibleEntityIds,
        positions,
      ),
      ...directedExactRelations(incidentRelations, positions),
    ];
  }

  const intraDomainRelations = visibleRelations.filter(
    (relation) =>
      entityDomain.get(relation.source) === entityDomain.get(relation.target),
  );
  return [
    ...domainAggregateRelations(
      relations,
      entityDomain,
      positions,
    ),
    ...compactExactRelations(intraDomainRelations, positions),
  ];
}

export function CodeGraph({
  entities,
  relations,
  selectedId,
  selectedDomainId,
  context,
  documents,
  showAllDocuments,
  search,
  mode,
  interactionPath,
  simulationStep,
  executionFlowId,
  onSelect,
  onSelectDomain,
  onClearSelection,
}: {
  entities: GraphEntity[];
  relations: GraphRelation[];
  selectedId?: string;
  selectedDomainId?: string;
  context?: EntityContext;
  documents: DocumentBinding[];
  showAllDocuments: boolean;
  search: string;
  mode: CodeViewMode;
  interactionPath: GraphRelation[];
  simulationStep: number;
  executionFlowId?: string;
  onSelect: (id?: string) => void;
  onSelectDomain: (domain?: CodeDomainLayout) => void;
  onClearSelection: () => void;
}) {
  const [collapsedDomains, setCollapsedDomains] = useState<Set<string>>(
    () => new Set(),
  );
  const [flowInstance, setFlowInstance] =
    useState<ReactFlowInstance | null>(null);
  const normalizedSearch = search.trim().toLowerCase();
  const effectiveCollapsedDomains = useMemo(
    () => (normalizedSearch ? new Set<string>() : collapsedDomains),
    [collapsedDomains, normalizedSearch],
  );
  const fallbackLayout = useMemo(
    () =>
      createFallbackCodeGraphLayout(
        entities,
        relations,
        effectiveCollapsedDomains,
      ),
    [effectiveCollapsedDomains, entities, relations],
  );
  const [layout, setLayout] = useState(fallbackLayout);
  useEffect(() => {
    let cancelled = false;
    setLayout(fallbackLayout);
    layoutCodeGraph(entities, relations, effectiveCollapsedDomains)
      .then((nextLayout) => {
        if (!cancelled) setLayout(nextLayout);
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("[graph-layout] ELK layout failed", error);
          setLayout(fallbackLayout);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    effectiveCollapsedDomains,
    entities,
    fallbackLayout,
    relations,
  ]);
  const positions = layout.positions;
  const graphPositions = useMemo(() => {
    const values = new Map(positions);
    for (const domain of layout.domains) {
      values.set(domain.id, domain.position);
    }
    return values;
  }, [layout.domains, positions]);
  const toggleDomain = useCallback(
    (domain: CodeDomainLayout) => {
      if (!domain.collapsed && selectedId && domain.entityIds.includes(selectedId)) {
        onSelect(undefined);
      }
      setCollapsedDomains((current) => {
        const next = new Set(current);
        if (next.has(domain.id)) next.delete(domain.id);
        else next.add(domain.id);
        return next;
      });
    },
    [onSelect, selectedId],
  );
  const graphKey = useMemo(
    () => `elk-grouped::${layout.version}::${layout.key}`,
    [layout.key, layout.version],
  );
  const related = useMemo(() => {
    const values = new Set<string>();
    if (!selectedId) return values;
    values.add(selectedId);
    for (const relation of relations) {
      if (relation.source === selectedId) values.add(relation.target);
      if (relation.target === selectedId) values.add(relation.source);
    }
    return values;
  }, [relations, selectedId]);
  const pathRelationIds = useMemo(
    () => new Set(interactionPath.map((relation) => relation.id)),
    [interactionPath],
  );
  const pathNodeIds = useMemo(() => {
    const values = new Set<string>();
    if (selectedId) values.add(selectedId);
    for (const relation of interactionPath) {
      values.add(relation.source);
      values.add(relation.target);
    }
    return values;
  }, [interactionPath, selectedId]);
  const completedRelationIds = useMemo(
    () =>
      new Set(
        interactionPath
          .slice(0, Math.max(0, simulationStep))
          .map((relation) => relation.id),
      ),
    [interactionPath, simulationStep],
  );
  const completedNodeIds = useMemo(() => {
    const values = new Set<string>();
    for (const relation of interactionPath.slice(
      0,
      Math.max(0, simulationStep),
    )) {
      values.add(relation.source);
      values.add(relation.target);
    }
    return values;
  }, [interactionPath, simulationStep]);
  const activeInteraction =
    simulationStep >= 0 && simulationStep < interactionPath.length
      ? interactionPath[simulationStep]
      : undefined;

  const contextNodes = useMemo<Node<ContextData>[]>(() => {
    const contextWidth = 218;
    const contextHeight = 76;
    const contextGap = 14;
    const domainById = new Map(
      layout.domains.map((domain) => [domain.id, domain]),
    );
    const visibleEntityIds = new Set(
      entities
        .filter((entity) => {
          if (entity.kind === "project") return false;
          const domainId = layout.entityDomain.get(entity.id);
          return !domainId || !effectiveCollapsedDomains.has(domainId);
        })
        .map((entity) => entity.id),
    );
    const graphObstacles: GraphRect[] = [
      ...layout.domains.map((domain) => ({
        ...domain.position,
        width: domain.width,
        height: domain.height,
      })),
      ...entities
        .filter((entity) => visibleEntityIds.has(entity.id))
        .map((entity) => ({
          ...(positions.get(entity.id) ?? { x: 0, y: 0 }),
          width: CODE_NODE_WIDTH,
          height: CODE_NODE_HEIGHT,
        })),
    ];
    const intersects = (left: GraphRect, right: GraphRect, padding = 0) =>
      left.x < right.x + right.width + padding &&
      left.x + left.width + padding > right.x &&
      left.y < right.y + right.height + padding &&
      left.y + left.height + padding > right.y;
    const resolveAnchor = (
      ownerId: string,
    ): { id: string; geometry: GraphNodeGeometry } | undefined => {
      const directDomain = domainById.get(ownerId);
      if (directDomain) {
        return {
          id: directDomain.id,
          geometry: {
            ...directDomain.position,
            width: directDomain.width,
            height: directDomain.height,
          },
        };
      }
      const domainId = layout.entityDomain.get(ownerId);
      if (domainId && effectiveCollapsedDomains.has(domainId)) {
        const domain = domainById.get(domainId);
        if (domain) {
          return {
            id: domain.id,
            geometry: {
              ...domain.position,
              width: domain.width,
              height: domain.height,
            },
          };
        }
      }
      if (!visibleEntityIds.has(ownerId)) return undefined;
      const position = positions.get(ownerId);
      if (!position) return undefined;
      return {
        id: ownerId,
        geometry: {
          ...position,
          width: CODE_NODE_WIDTH,
          height: CODE_NODE_HEIGHT,
        },
      };
    };

    const selectedAnchorId = selectedDomainId ?? selectedId;
    const visibleDocuments =
      showAllDocuments
        ? documents
        : selectedAnchorId
          ? documents.filter(
              (document) => document.entityId === selectedAnchorId,
            )
          : [];
    const groupedDocuments = new Map<
      string,
      {
        anchor: { id: string; geometry: GraphNodeGeometry };
        values: DocumentBinding[];
      }
    >();
    for (const document of visibleDocuments) {
      const anchor = resolveAnchor(document.entityId);
      if (!anchor) continue;
      const group = groupedDocuments.get(anchor.id) ?? {
        anchor,
        values: [],
      };
      group.values.push(document);
      groupedDocuments.set(anchor.id, group);
    }

    const occupied: GraphRect[] = [];
    const documentNodes: Node<ContextData>[] = [];
    const groups = [...groupedDocuments.values()].sort(
      (left, right) =>
        left.anchor.geometry.y - right.anchor.geometry.y ||
        left.anchor.geometry.x - right.anchor.geometry.x,
    );
    for (const group of groups) {
      const stackHeight =
        group.values.length * contextHeight +
        Math.max(0, group.values.length - 1) * contextGap;
      let x =
        group.anchor.geometry.x -
        contextWidth -
        (showAllDocuments ? 70 : 92);
      let y =
        group.anchor.geometry.y +
        group.anchor.geometry.height / 2 -
        stackHeight / 2;
      let stackRect = {
        x,
        y,
        width: contextWidth,
        height: stackHeight,
      };
      let horizontalAttempts = 0;
      while (
        graphObstacles.some((obstacle) =>
          intersects(stackRect, obstacle, 18),
        ) &&
        horizontalAttempts < 5
      ) {
        x -= contextWidth + 44;
        stackRect = { ...stackRect, x };
        horizontalAttempts += 1;
      }
      let collisions = occupied.filter((item) =>
        intersects(stackRect, item, 12),
      );
      while (collisions.length > 0) {
        y =
          Math.max(...collisions.map((item) => item.y + item.height)) +
          contextGap;
        stackRect = { ...stackRect, y };
        collisions = occupied.filter((item) =>
          intersects(stackRect, item, 12),
        );
      }
      occupied.push(stackRect);
      group.values.forEach((document, index) => {
        documentNodes.push({
          id: `document:${document.id}`,
          type: "context",
          position: {
            x,
            y: y + index * (contextHeight + contextGap),
          },
          data: {
            kind: "document",
            anchorId: group.anchor.id,
            title: document.title,
            detail: document.summary || document.provider,
            url: document.url,
          },
          draggable: false,
          selectable: false,
          width: contextWidth,
          height: contextHeight,
          zIndex: 30,
        });
      });
    }

    const selectedAnchor = selectedAnchorId
      ? resolveAnchor(selectedAnchorId)
      : undefined;
    const annotationNodes: Node<ContextData>[] =
      mode === "focus" && context && selectedAnchor
        ? context.annotations.map((annotation, index) => ({
            id: `annotation:${annotation.id}`,
            type: "context",
            position: {
              x:
                selectedAnchor.geometry.x +
                selectedAnchor.geometry.width +
                122,
              y:
                selectedAnchor.geometry.y -
                (context.annotations.length - 1) * 48 +
                index * 96,
            },
            data: {
              kind: "annotation",
              anchorId: selectedAnchor.id,
              title: annotation.author,
              detail: annotation.body,
            },
            draggable: false,
            selectable: false,
            width: contextWidth,
            height: contextHeight,
            zIndex: 30,
          }))
        : [];
    return [...documentNodes, ...annotationNodes];
  }, [
    context,
    documents,
    effectiveCollapsedDomains,
    entities,
    layout.domains,
    layout.entityDomain,
    mode,
    positions,
    selectedDomainId,
    selectedId,
    showAllDocuments,
  ]);
  const contextNodeSignature = useMemo(
    () =>
      contextNodes
        .map(
          (node) =>
            `${node.id}:${Math.round(node.position.x)}:${Math.round(node.position.y)}`,
        )
        .join("|"),
    [contextNodes],
  );

  useEffect(() => {
    if (!flowInstance || contextNodes.length === 0) return;
    const frame = window.requestAnimationFrame(() => {
      const flow = document.querySelector(
        ".vision-code-canvas .react-flow",
      );
      const cards = document.querySelectorAll(
        ".vision-code-canvas .react-flow__node-context",
      );
      const bounds = flow?.getBoundingClientRect();
      const outsideViewport =
        bounds &&
        [...cards].some((card) => {
          const rect = card.getBoundingClientRect();
          return (
            rect.left < bounds.left + 6 ||
            rect.right > bounds.right - 6 ||
            rect.top < bounds.top + 6 ||
            rect.bottom > bounds.bottom - 6
          );
        });
      if (showAllDocuments || outsideViewport) {
        void flowInstance.fitView({
          padding: 0.08,
          maxZoom: 0.9,
          duration: 260,
        });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    contextNodeSignature,
    contextNodes.length,
    flowInstance,
    showAllDocuments,
  ]);

  const nodes = useMemo<Node[]>(() => {
    const domainNodes: Node<DomainNodeData>[] = layout.domains.map((domain) => ({
      id: domain.id,
      type: "domain",
      position: domain.position,
      width: domain.width,
      height: domain.height,
      style: {
        width: domain.width,
        height: domain.height,
      },
      data: {
        domain,
        onSelect: onSelectDomain,
        onToggle: toggleDomain,
      },
      draggable: false,
      selectable: false,
      selected: domain.id === selectedDomainId,
      zIndex: domain.id === selectedDomainId ? 12 : 9,
    }));
    const codeNodes: Node<CodeNodeData>[] = entities
      .filter((entity) => {
        if (entity.kind === "project") return false;
        const domainId = layout.entityDomain.get(entity.id);
        return !domainId || !effectiveCollapsedDomains.has(domainId);
      })
      .map((entity) => {
      const haystack = `${entity.name} ${entity.path ?? ""} ${entity.summary}`.toLowerCase();
      const searchDimmed = Boolean(normalizedSearch && !haystack.includes(normalizedSearch));
      const selectionDimmed =
        mode === "focus"
          ? Boolean(selectedId && !related.has(entity.id))
          : mode === "simulation"
            ? Boolean(selectedId && !pathNodeIds.has(entity.id))
            : false;
      const simulationState =
        mode !== "simulation" || !pathNodeIds.has(entity.id)
          ? undefined
          : activeInteraction?.target === entity.id
            ? ("active" as const)
            : completedNodeIds.has(entity.id)
              ? ("complete" as const)
              : ("queued" as const);
      const executionOrders = entity.metadata.executionOrderByFlow;
      const executionStep =
        executionFlowId &&
        executionOrders &&
        typeof executionOrders === "object" &&
        typeof (executionOrders as Record<string, unknown>)[executionFlowId] ===
          "number"
          ? ((executionOrders as Record<string, number>)[executionFlowId] as number)
          : undefined;
      return {
        id: entity.id,
        type: "code",
        position: positions.get(entity.id) ?? { x: 0, y: 0 },
        width: 228,
        height: 84,
        data: {
          entity,
          related:
            mode === "focus"
              ? Boolean(selectedId && related.has(entity.id))
              : mode === "simulation"
                ? pathNodeIds.has(entity.id)
                : false,
          dimmed: searchDimmed || selectionDimmed,
          executionStep,
          simulationState,
        },
        selected: entity.id === selectedId,
        draggable: false,
        zIndex: entity.id === selectedId ? 20 : related.has(entity.id) ? 14 : 10,
      };
    });
    return [...domainNodes, ...codeNodes, ...contextNodes];
  }, [
    contextNodes,
    effectiveCollapsedDomains,
    entities,
    executionFlowId,
    layout.domains,
    layout.entityDomain,
    normalizedSearch,
    activeInteraction,
    completedNodeIds,
    mode,
    pathNodeIds,
    positions,
    related,
    selectedId,
    selectedDomainId,
    onSelectDomain,
    toggleDomain,
  ]);

  const geometryById = useMemo(() => {
    const geometries = new Map<string, GraphNodeGeometry>();
    for (const domain of layout.domains) {
      geometries.set(domain.id, {
        ...domain.position,
        width: domain.width,
        height: domain.height,
      });
    }
    for (const entity of entities) {
      const position = positions.get(entity.id);
      if (!position) continue;
      geometries.set(entity.id, {
        ...position,
        width: CODE_NODE_WIDTH,
        height: CODE_NODE_HEIGHT,
      });
    }
    return geometries;
  }, [entities, layout.domains, positions]);

  const edges = useMemo<Edge[]>(() => {
    const visibleEntityIds = new Set(
      entities
        .filter((entity) => {
          if (entity.kind === "project") return false;
          const domainId = layout.entityDomain.get(entity.id);
          return !domainId || !effectiveCollapsedDomains.has(domainId);
        })
        .map((entity) => entity.id),
    );
    const structuralRelations = relations.filter(
      (relation) => relation.type !== "contains",
    );
    const displayItems = displayRelations({
      relations: structuralRelations,
      mode,
      positions: graphPositions,
      entityDomain: layout.entityDomain,
      visibleEntityIds,
      pathRelationIds,
      selectedId,
    });
    const moduleLabelObstacles = [...visibleEntityIds]
      .map((entityId) => geometryById.get(entityId))
      .filter((geometry): geometry is GraphNodeGeometry => Boolean(geometry))
      .map((geometry) => ({
        x: geometry.x - 10,
        y: geometry.y - 10,
        width: geometry.width + 20,
        height: geometry.height + 20,
      }));
    const aggregateLabelObstacles = [
      ...moduleLabelObstacles,
      ...layout.domains.map((domain) => ({
        x: domain.position.x - 10,
        y: domain.position.y - 10,
        width: domain.width + 20,
        height: domain.height + 20,
      })),
    ];
    const occupiedLabels: GraphRect[] = [];
    const graphEdges = displayItems.map((relation) => {
      const directlyRelated =
        Boolean(selectedId) &&
        (relation.source === selectedId || relation.target === selectedId);
      const pathRelation =
        mode === "simulation" &&
        relation.relationIds.some((id) => pathRelationIds.has(id));
      const active = relation.relationIds.includes(
        activeInteraction?.id ?? "",
      );
      const completed = relation.relationIds.some((id) =>
        completedRelationIds.has(id),
      );
      const emphasized =
        relation.execution ||
        (mode === "simulation" ? completed : directlyRelated);
      const showLabel =
        relation.execution ||
        relation.aggregate ||
        directlyRelated ||
        pathRelation;
      const dimmed =
        mode === "focus"
          ? Boolean(selectedId && !directlyRelated)
          : mode === "simulation"
            ? Boolean(selectedId && !pathRelation)
            : false;
      const fallbackGeometry = {
        x: 0,
        y: 0,
        width: CODE_NODE_WIDTH,
        height: CODE_NODE_HEIGHT,
      };
      const handles = relationHandles(
        geometryById.get(relation.source) ?? fallbackGeometry,
        geometryById.get(relation.target) ?? fallbackGeometry,
      );
      const labelPosition = showLabel
        ? placeRelationLabel({
            relation,
            handles,
            geometries: geometryById,
            obstacles: relation.aggregate
              ? aggregateLabelObstacles
              : moduleLabelObstacles,
            occupied: occupiedLabels,
          })
        : undefined;
      const edge: Edge = {
        id: relation.id,
        source: relation.source,
        target: relation.target,
        sourceHandle: handles.sourceHandle,
        targetHandle: handles.targetHandle,
        type: active ? "simulation" : "clarity",
        className: [
          "vision-code-edge",
          relation.aggregate ? "is-aggregate" : "",
          relation.execution ? "is-execution" : "",
          !showLabel ? "is-background" : "",
          emphasized ? "is-emphasized" : "",
          pathRelation && !completed ? "is-path-pending" : "",
          dimmed ? "is-dimmed" : "",
        ]
          .filter(Boolean)
          .join(" "),
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: emphasized ? 13 : relation.aggregate ? 12 : 11,
          height: emphasized ? 13 : relation.aggregate ? 12 : 11,
          color:
            active || emphasized
              ? "#58ff3d"
              : relation.aggregate
                ? "#829182"
                : "#657065",
        },
        markerStart: relation.bidirectional
          ? {
              type: MarkerType.ArrowClosed,
              width: emphasized ? 13 : relation.aggregate ? 12 : 11,
              height: emphasized ? 13 : relation.aggregate ? 12 : 11,
              color:
                active || emphasized
                  ? "#58ff3d"
                  : relation.aggregate
                    ? "#829182"
                    : "#657065",
            }
          : undefined,
        zIndex: active ? 7 : emphasized ? 6 : relation.aggregate ? 1 : 2,
      };
      if (active) {
        edge.data = {
          label: relation.label,
          pulse: !relation.reciprocal,
          labelX: labelPosition?.x,
          labelY: labelPosition?.y,
        } satisfies SimulationEdgeData;
      } else {
        edge.data = {
          label: showLabel ? relation.label : undefined,
          emphasized,
          dimmed,
          background: !showLabel,
          pending: pathRelation && !completed,
          lane: relation.lane,
          pulse: emphasized && !relation.reciprocal,
          aggregate: relation.aggregate,
          execution: relation.execution,
          labelX: labelPosition?.x,
          labelY: labelPosition?.y,
        } satisfies ClarityEdgeData;
      }
      return edge;
    });
    const contextEdges: Edge[] = contextNodes.map((node) => {
      const document = node.data.kind === "document";
      const anchorId = node.data.anchorId;
      return {
        id: `context-edge:${node.id}`,
        source: document ? node.id : anchorId,
        target: document ? anchorId : node.id,
        sourceHandle: document ? "context-right" : "source-right",
        targetHandle: document ? "target-left" : "context-left",
        type: "straight",
        className: `vision-context-edge is-${node.data.kind}`,
        selectable: false,
        zIndex: 22,
      };
    });
    return [...graphEdges, ...contextEdges];
  }, [
    activeInteraction,
    completedRelationIds,
    contextNodes,
    effectiveCollapsedDomains,
    entities,
    geometryById,
    graphPositions,
    layout.domains,
    layout.entityDomain,
    mode,
    pathRelationIds,
    relations,
    selectedId,
  ]);

  return (
    <ReactFlow
      key={graphKey}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onInit={setFlowInstance}
      fitView
      fitViewOptions={{ padding: 0.08, maxZoom: 1.02 }}
      minZoom={0.16}
      maxZoom={1.55}
      nodesDraggable={false}
      nodesConnectable={false}
      onNodeClick={(_, node) => {
        if (node.type === "code") onSelect(node.id);
      }}
      onPaneClick={onClearSelection}
      panOnScroll
      zoomOnDoubleClick={false}
      proOptions={{ hideAttribution: true }}
    >
      <Controls
        position="bottom-left"
        showInteractive={false}
        fitViewOptions={{ padding: 0.08, maxZoom: 1.02 }}
      />
      <Panel className="vision-code-legend" position="bottom-right">
        <span>
          <i className="is-code" />
          代码模块
        </span>
        <span>
          <i className="is-infrastructure" />
          基础设施
        </span>
        <span>
          <i className="is-trunk" />
          跨域主干
        </span>
        <span>
          <i className="is-exact" />
          域内依赖
        </span>
      </Panel>
    </ReactFlow>
  );
}
