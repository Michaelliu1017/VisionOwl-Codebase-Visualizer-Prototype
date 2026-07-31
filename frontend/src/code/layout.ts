import type { GraphEntity, GraphRelation } from "@visionowl/contracts";
import { aggregateRelationsByDomain } from "./edgeAggregation";
import {
  centeredGridLayout,
  runLayeredLayout,
  type LayeredLayoutResult,
  type LayoutNode,
} from "./elkLayout";

export const CODE_NODE_WIDTH = 228;
export const CODE_NODE_HEIGHT = 84;

const DOMAIN_HEADER_HEIGHT = 56;
const DOMAIN_PADDING_X = 34;
const DOMAIN_PADDING_BOTTOM = 34;
const DOMAIN_GAP = 118;
const DOMAIN_LAYER_GAP = 132;
const MEMBER_COLUMN_GAP = 96;
const MEMBER_ROW_GAP = 88;
const COLLAPSED_DOMAIN_WIDTH = 244;
const COLLAPSED_DOMAIN_HEIGHT = 58;
const MAX_DOMAINS = 8;

export type CodeDomainLayout = {
  id: string;
  key: string;
  label: string;
  entityIds: string[];
  position: { x: number; y: number };
  width: number;
  height: number;
  collapsed: boolean;
  execution: boolean;
  infrastructure: boolean;
};

export type CodeGraphLayout = {
  positions: Map<string, { x: number; y: number }>;
  domains: CodeDomainLayout[];
  entityDomain: Map<string, string>;
  version: "fallback" | "elk" | "execution";
  key: string;
};

type MemberRecord = {
  filePath?: unknown;
};

type DomainSeed = {
  id: string;
  key: string;
  label: string;
  entities: GraphEntity[];
  collapsed: boolean;
};

type DomainCandidate = {
  depth: number;
  groups: Map<string, GraphEntity[]>;
  largestRatio: number;
};

function memberPaths(entity: GraphEntity) {
  const members = Array.isArray(entity.metadata.members)
    ? (entity.metadata.members as MemberRecord[])
    : [];
  return members
    .map((member) =>
      typeof member.filePath === "string" ? member.filePath : "",
    )
    .filter(Boolean);
}

function directoryPrefix(filePath: string, depth: number) {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  const directories = segments.length > 1 ? segments.slice(0, -1) : [];
  if (directories.length === 0) return "project";
  return directories.slice(0, depth).join("/");
}

function explicitDomain(entity: GraphEntity) {
  const explicitDomain =
    typeof entity.metadata.domain === "string"
      ? entity.metadata.domain.trim()
      : "";
  return explicitDomain || undefined;
}

function dominantDomainAtDepth(entity: GraphEntity, depth: number) {
  const explicit = explicitDomain(entity);
  if (explicit) return explicit;
  const counts = new Map<string, number>();
  for (const filePath of memberPaths(entity)) {
    const key = directoryPrefix(filePath, depth);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 0) {
    return "project";
  }
  return [...counts.entries()].sort(
    ([leftKey, leftCount], [rightKey, rightCount]) =>
      rightCount - leftCount || leftKey.localeCompare(rightKey),
  )[0][0];
}

function candidateAtDepth(entities: GraphEntity[], depth: number) {
  const groups = new Map<string, GraphEntity[]>();
  for (const entity of entities) {
    const key = dominantDomainAtDepth(entity, depth);
    groups.set(key, [...(groups.get(key) ?? []), entity]);
  }
  const largest = Math.max(0, ...[...groups.values()].map((group) => group.length));
  return {
    depth,
    groups,
    largestRatio: entities.length === 0 ? 0 : largest / entities.length,
  } satisfies DomainCandidate;
}

function domainCandidateScore(candidate: DomainCandidate) {
  const groupCount = candidate.groups.size;
  const targetGroupCount = Math.min(MAX_DOMAINS, 4);
  const groupPenalty = Math.abs(groupCount - targetGroupCount) * 0.16;
  const dominancePenalty = Math.max(0, candidate.largestRatio - 0.58) * 2.4;
  const overflowPenalty = Math.max(0, groupCount - MAX_DOMAINS) * 0.35;
  return 1 - groupPenalty - dominancePenalty - overflowPenalty;
}

function derivePathGroups(entities: GraphEntity[]) {
  if (entities.length <= 1) {
    return candidateAtDepth(entities, 1).groups;
  }
  const candidates = [1, 2, 3].map((depth) =>
    candidateAtDepth(entities, depth),
  );
  const acceptable = candidates.find(
    (candidate) =>
      candidate.groups.size >= 2 &&
      candidate.groups.size <= MAX_DOMAINS &&
      candidate.largestRatio <= 0.7,
  );
  const selected =
    acceptable ??
    [...candidates].sort(
      (left, right) =>
        domainCandidateScore(right) - domainCandidateScore(left) ||
        left.depth - right.depth,
    )[0];
  return selected.groups;
}

function domainLabel(key: string) {
  const leaf = key.split("/").filter(Boolean).at(-1) ?? key;
  const known: Record<string, string> = {
    agent: "Agent Control",
    app: "Application",
    backend: "Backend",
    client: "Client",
    docs: "Documentation",
    documentation: "Documentation",
    frontend: "Frontend",
    packages: "Shared Packages",
    project: "Project & Docs",
    scripts: "Build & Scripts",
    server: "Server",
    services: "Services",
    src: "Source",
    task: "Task Runtime",
    tool: "Shared Tooling",
    ui: "UI",
    web: "Web",
  };
  if (known[leaf.toLowerCase()]) return known[leaf.toLowerCase()];
  return leaf
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) =>
      part.toLowerCase() === "ui"
        ? "UI"
        : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(" ");
}

function domainId(key: string) {
  const slug = key.toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "project";
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `visual-domain:${slug}:${hash.toString(36)}`;
}

function mergeSmallDomains(groups: Map<string, GraphEntity[]>) {
  if (groups.size <= MAX_DOMAINS) return groups;
  const ranked = [...groups.entries()].sort(
    ([leftKey, left], [rightKey, right]) =>
      right.length - left.length || leftKey.localeCompare(rightKey),
  );
  const kept = new Set(ranked.slice(0, MAX_DOMAINS - 1).map(([key]) => key));
  const merged = new Map<string, GraphEntity[]>();
  for (const [key, values] of groups) {
    const target = kept.has(key) ? key : "other";
    merged.set(target, [...(merged.get(target) ?? []), ...values]);
  }
  return merged;
}

function flowScores(
  entities: GraphEntity[],
  relations: GraphRelation[],
  entityDomain: Map<string, string>,
) {
  const entityIds = new Set(entities.map((entity) => entity.id));
  const entityScores = new Map<string, number>();
  for (const relation of relations) {
    if (
      relation.type === "contains" ||
      !entityIds.has(relation.source) ||
      !entityIds.has(relation.target)
    ) {
      continue;
    }
    entityScores.set(
      relation.source,
      (entityScores.get(relation.source) ?? 0) + 1,
    );
    entityScores.set(
      relation.target,
      (entityScores.get(relation.target) ?? 0) - 1,
    );
  }
  return entityScores;
}

function deriveDomainSeeds(
  entities: GraphEntity[],
  relations: GraphRelation[],
  collapsedDomainIds: ReadonlySet<string>,
) {
  const modules = entities.filter((entity) => entity.kind !== "project");
  const preliminaryGroups = derivePathGroups(modules);
  const groups = mergeSmallDomains(preliminaryGroups);
  const entityDomain = new Map<string, string>();
  for (const [key, values] of groups) {
    const id = domainId(key);
    for (const entity of values) entityDomain.set(entity.id, id);
  }
  const entityScores = flowScores(modules, relations, entityDomain);
  const seeds: DomainSeed[] = [...groups.entries()]
    .map(([key, values]) => {
      const id = domainId(key);
      return {
        id,
        key,
        label: key === "other" ? "Other Modules" : domainLabel(key),
        entities: [...values].sort(
          (left, right) =>
            (entityScores.get(right.id) ?? 0) -
              (entityScores.get(left.id) ?? 0) ||
            `${left.layer ?? ""}:${left.name}`.localeCompare(
              `${right.layer ?? ""}:${right.name}`,
            ),
        ),
        collapsed: collapsedDomainIds.has(id),
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
  return { modules, seeds, entityDomain };
}

function graphKey(
  entities: GraphEntity[],
  relations: GraphRelation[],
  collapsedDomainIds: ReadonlySet<string>,
) {
  return [
    entities
      .filter((entity) => entity.kind !== "project")
      .map((entity) => entity.id)
      .sort()
      .join("|"),
    relations
      .filter((relation) => relation.type !== "contains")
      .map(
        (relation) =>
          `${relation.id}:${relation.source}:${relation.target}:${relation.type}`,
      )
      .sort()
      .join("|"),
    [...collapsedDomainIds].sort().join("|"),
  ].join("::");
}

function memberEdges(
  seed: DomainSeed,
  relations: GraphRelation[],
) {
  const memberIds = new Set(seed.entities.map((entity) => entity.id));
  return relations
    .filter(
      (relation) =>
        relation.type !== "contains" &&
        memberIds.has(relation.source) &&
        memberIds.has(relation.target) &&
        relation.source !== relation.target,
    )
    .map((relation) => ({
      id: relation.id,
      source: relation.source,
      target: relation.target,
    }));
}

function memberNodes(seed: DomainSeed): LayoutNode[] {
  return seed.entities.map((entity) => ({
    id: entity.id,
    width: CODE_NODE_WIDTH,
    height: CODE_NODE_HEIGHT,
  }));
}

function fallbackMemberLayout(seed: DomainSeed) {
  const memberCount = seed.entities.length;
  return centeredGridLayout(memberNodes(seed), {
    columnGap: MEMBER_COLUMN_GAP,
    rowGap: MEMBER_ROW_GAP,
    maxColumns:
      memberCount <= 1 ? 1 : memberCount === 2 ? 2 : memberCount <= 4 ? 2 : 3,
  });
}

async function layoutDomainMembers(
  seed: DomainSeed,
  relations: GraphRelation[],
): Promise<LayeredLayoutResult> {
  const nodes = memberNodes(seed);
  const edges = memberEdges(seed, relations);
  if (nodes.length <= 1 || edges.length === 0) return fallbackMemberLayout(seed);
  const possibleDirectedEdges = nodes.length * Math.max(1, nodes.length - 1);
  const density = edges.length / possibleDirectedEdges;
  if (density >= 0.42 || edges.length > nodes.length * 2.2) {
    return fallbackMemberLayout(seed);
  }
  return runLayeredLayout({
    id: `${seed.id}:members`,
    nodes,
    edges,
    direction: "DOWN",
    nodeSpacing: MEMBER_COLUMN_GAP,
    layerSpacing: MEMBER_ROW_GAP,
  });
}

function domainFromMemberLayout(
  seed: DomainSeed,
  memberLayout: LayeredLayoutResult,
): CodeDomainLayout {
  if (seed.collapsed) {
    return {
      id: seed.id,
      key: seed.key,
      label: seed.label,
      entityIds: seed.entities.map((entity) => entity.id),
      position: { x: 0, y: 0 },
      width: COLLAPSED_DOMAIN_WIDTH,
      height: COLLAPSED_DOMAIN_HEIGHT,
      collapsed: true,
      execution: false,
      infrastructure: seed.entities.every(
        (entity) => entity.metadata.architectureResource === true,
      ),
    };
  }
  return {
    id: seed.id,
    key: seed.key,
    label: seed.label,
    entityIds: seed.entities.map((entity) => entity.id),
    position: { x: 0, y: 0 },
    width: Math.max(
      COLLAPSED_DOMAIN_WIDTH,
      memberLayout.width + DOMAIN_PADDING_X * 2,
    ),
    height:
      DOMAIN_HEADER_HEIGHT +
      memberLayout.height +
      DOMAIN_PADDING_BOTTOM,
    collapsed: false,
    execution: false,
    infrastructure: seed.entities.every(
      (entity) => entity.metadata.architectureResource === true,
    ),
  };
}

function executionFlowId(relations: GraphRelation[]) {
  const flowIds = new Set(
    relations
      .filter((relation) => relation.metadata.execution === true)
      .map((relation) =>
        typeof relation.metadata.flowId === "string"
          ? relation.metadata.flowId
          : "",
      )
      .filter(Boolean),
  );
  return flowIds.size === 1 ? [...flowIds][0] : undefined;
}

function numericMetadataValue(
  entity: GraphEntity,
  field: "executionOrderByFlow" | "executionLaneOrderByFlow",
  flowId: string,
) {
  const values = entity.metadata[field];
  if (!values || typeof values !== "object") return 0;
  const value = (values as Record<string, unknown>)[flowId];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function createExecutionLayout(
  entities: GraphEntity[],
  relations: GraphRelation[],
  flowId: string,
): CodeGraphLayout {
  const executionEntities = entities
    .filter((entity) => entity.metadata.execution === true)
    .sort(
      (left, right) =>
        numericMetadataValue(left, "executionOrderByFlow", flowId) -
        numericMetadataValue(right, "executionOrderByFlow", flowId),
    );
  const segments: Array<{ domain: string; entities: GraphEntity[] }> = [];
  for (const entity of executionEntities) {
    const domain = explicitDomain(entity) ?? "Execution";
    const current = segments.at(-1);
    if (current?.domain === domain) current.entities.push(entity);
    else segments.push({ domain, entities: [entity] });
  }

  const segmentWidth = CODE_NODE_WIDTH + DOMAIN_PADDING_X * 2;
  const segmentGap = 124;
  const longestExecutionLabelWidth = Math.max(
    0,
    ...relations
      .filter((relation) => relation.metadata.execution === true)
      .map((relation) => Array.from(relation.label).length * 7.2 + 18),
  );
  const executionLabelLines = Math.max(
    1,
    Math.ceil(longestExecutionLabelWidth / 190),
  );
  const executionLabelHeight = Math.min(
    58,
    Math.max(26, 14 + executionLabelLines * 13),
  );
  const stepGap = Math.max(
    148,
    CODE_NODE_HEIGHT + executionLabelHeight + 36,
  );
  const maxSegmentSize = Math.max(
    1,
    ...segments.map((segment) => segment.entities.length),
  );
  const laneHeight =
    DOMAIN_HEADER_HEIGHT +
    maxSegmentSize * stepGap +
    DOMAIN_PADDING_BOTTOM;
  const positions = new Map<string, { x: number; y: number }>();
  const entityDomain = new Map<string, string>();

  const domains = segments.map(
    (segment, segmentIndex): CodeDomainLayout => {
      const key = `${String(segmentIndex + 1).padStart(2, "0")} · ${segment.domain}`;
      const id = domainId(`execution:${flowId}:${segmentIndex}:${segment.domain}`);
      const x = segmentIndex * (segmentWidth + segmentGap);
      const reversed = segmentIndex % 2 === 1;
      for (const [localIndex, entity] of segment.entities.entries()) {
        const progress =
          segment.entities.length === 1
            ? 0.5
            : localIndex / (segment.entities.length - 1);
        const laneProgress = reversed ? 1 - progress : progress;
        entityDomain.set(entity.id, id);
        positions.set(entity.id, {
          x: x + DOMAIN_PADDING_X,
          y:
            DOMAIN_HEADER_HEIGHT +
            laneProgress * (maxSegmentSize - 1) * stepGap +
            16,
        });
      }
      return {
        id,
        key,
        label: key,
        entityIds: segment.entities.map((entity) => entity.id),
        position: { x, y: 0 },
        width: segmentWidth,
        height: laneHeight,
        collapsed: false,
        execution: true,
        infrastructure: false,
      };
    },
  );

  return {
    positions,
    domains,
    entityDomain,
    version: "execution",
    key: `execution:${flowId}:${graphKey(entities, relations, new Set())}`,
  };
}

function positionMembers(
  positions: Map<string, { x: number; y: number }>,
  domain: CodeDomainLayout,
  memberLayout: LayeredLayoutResult,
) {
  if (domain.collapsed) return;
  for (const [entityId, position] of memberLayout.positions) {
    positions.set(entityId, {
      x: domain.position.x + DOMAIN_PADDING_X + position.x,
      y: domain.position.y + DOMAIN_HEADER_HEIGHT + position.y,
    });
  }
}

function fallbackDomainLayout(domains: CodeDomainLayout[]) {
  return centeredGridLayout(
    domains.map((domain) => ({
      id: domain.id,
      width: domain.width,
      height: domain.height,
    })),
    {
      columnGap: DOMAIN_GAP,
      rowGap: DOMAIN_LAYER_GAP,
      maxColumns:
        domains.length >= 7
          ? 4
          : domains.length >= 5
            ? 3
            : domains.length >= 2
              ? 2
              : 1,
    },
  );
}

function segmentsCross(
  left: { sourceDomainId: string; targetDomainId: string },
  right: { sourceDomainId: string; targetDomainId: string },
  centers: ReadonlyMap<string, { x: number; y: number }>,
) {
  if (
    left.sourceDomainId === right.sourceDomainId ||
    left.sourceDomainId === right.targetDomainId ||
    left.targetDomainId === right.sourceDomainId ||
    left.targetDomainId === right.targetDomainId
  ) {
    return false;
  }
  const a = centers.get(left.sourceDomainId);
  const b = centers.get(left.targetDomainId);
  const c = centers.get(right.sourceDomainId);
  const d = centers.get(right.targetDomainId);
  if (!a || !b || !c || !d) return false;
  const direction = (
    first: { x: number; y: number },
    second: { x: number; y: number },
    point: { x: number; y: number },
  ) =>
    (point.x - first.x) * (second.y - first.y) -
    (point.y - first.y) * (second.x - first.x);
  const abC = direction(a, b, c);
  const abD = direction(a, b, d);
  const cdA = direction(c, d, a);
  const cdB = direction(c, d, b);
  return abC * abD < 0 && cdA * cdB < 0;
}

function scoreDomainLayout(
  domains: CodeDomainLayout[],
  layout: LayeredLayoutResult,
  aggregates: ReturnType<typeof aggregateRelationsByDomain>,
) {
  const centers = new Map(
    domains.map((domain) => {
      const position = layout.positions.get(domain.id) ?? { x: 0, y: 0 };
      return [
        domain.id,
        {
          x: position.x + domain.width / 2,
          y: position.y + domain.height / 2,
        },
      ] as const;
    }),
  );
  let score = 0;
  for (const aggregate of aggregates) {
    const source = centers.get(aggregate.sourceDomainId);
    const target = centers.get(aggregate.targetDomainId);
    if (!source || !target) continue;
    const distance =
      Math.abs(source.x - target.x) + Math.abs(source.y - target.y);
    score += distance * Math.max(1, Math.log2(aggregate.count + 1));
  }
  for (let left = 0; left < aggregates.length; left += 1) {
    for (let right = left + 1; right < aggregates.length; right += 1) {
      if (segmentsCross(aggregates[left], aggregates[right], centers)) {
        score += 1800;
      }
    }
  }
  return score;
}

function compactDomainLayout(
  domains: CodeDomainLayout[],
  aggregates: ReturnType<typeof aggregateRelationsByDomain>,
) {
  const flowScore = new Map<string, number>();
  for (const aggregate of aggregates) {
    flowScore.set(
      aggregate.sourceDomainId,
      (flowScore.get(aggregate.sourceDomainId) ?? 0) + aggregate.count,
    );
    flowScore.set(
      aggregate.targetDomainId,
      (flowScore.get(aggregate.targetDomainId) ?? 0) - aggregate.count,
    );
  }
  let ordered = [...domains].sort(
    (left, right) =>
      (flowScore.get(right.id) ?? 0) - (flowScore.get(left.id) ?? 0) ||
      left.label.localeCompare(right.label),
  );
  const build = (values: CodeDomainLayout[]) => fallbackDomainLayout(values);
  let layout = build(ordered);
  let score = scoreDomainLayout(ordered, layout, aggregates);

  for (let pass = 0; pass < domains.length; pass += 1) {
    let improved = false;
    for (let left = 0; left < ordered.length; left += 1) {
      for (let right = left + 1; right < ordered.length; right += 1) {
        const candidate = [...ordered];
        [candidate[left], candidate[right]] = [candidate[right], candidate[left]];
        const candidateLayout = build(candidate);
        const candidateScore = scoreDomainLayout(
          candidate,
          candidateLayout,
          aggregates,
        );
        if (candidateScore + 0.5 < score) {
          ordered = candidate;
          layout = candidateLayout;
          score = candidateScore;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return layout;
}

function domainLayoutEdges(
  aggregates: ReturnType<typeof aggregateRelationsByDomain>,
) {
  const pairs = new Map<string, typeof aggregates>();
  for (const aggregate of aggregates) {
    const key = [
      aggregate.sourceDomainId,
      aggregate.targetDomainId,
    ]
      .sort()
      .join("\u0000");
    pairs.set(key, [...(pairs.get(key) ?? []), aggregate]);
  }
  return [...pairs.entries()].map(([key, values]) => {
    const ranked = [...values].sort(
      (left, right) =>
        right.count - left.count ||
        left.sourceDomainId.localeCompare(right.sourceDomainId) ||
        left.targetDomainId.localeCompare(right.targetDomainId),
    );
    const chosen = ranked[0];
    return {
      id: `layout:${key}`,
      source: chosen.sourceDomainId,
      target: chosen.targetDomainId,
    };
  });
}

export function createFallbackCodeGraphLayout(
  entities: GraphEntity[],
  relations: GraphRelation[],
  collapsedDomainIds: ReadonlySet<string> = new Set(),
): CodeGraphLayout {
  const flowId = executionFlowId(relations);
  if (flowId) return createExecutionLayout(entities, relations, flowId);

  const { seeds, entityDomain } = deriveDomainSeeds(
    entities,
    relations,
    collapsedDomainIds,
  );
  const memberLayouts = new Map(
    seeds.map((seed) => [seed.id, fallbackMemberLayout(seed)]),
  );
  const domains = seeds.map((seed) =>
    domainFromMemberLayout(seed, memberLayouts.get(seed.id)!),
  );
  const domainLayout = compactDomainLayout(
    domains,
    aggregateRelationsByDomain(relations, entityDomain),
  );
  const positions = new Map<string, { x: number; y: number }>();

  for (const domain of domains) {
    domain.position = domainLayout.positions.get(domain.id) ?? { x: 0, y: 0 };
    positionMembers(positions, domain, memberLayouts.get(domain.id)!);
  }

  return {
    positions,
    domains,
    entityDomain,
    version: "fallback",
    key: graphKey(entities, relations, collapsedDomainIds),
  };
}

export async function layoutCodeGraph(
  entities: GraphEntity[],
  relations: GraphRelation[],
  collapsedDomainIds: ReadonlySet<string> = new Set(),
): Promise<CodeGraphLayout> {
  const flowId = executionFlowId(relations);
  if (flowId) return createExecutionLayout(entities, relations, flowId);

  const { seeds, entityDomain } = deriveDomainSeeds(
    entities,
    relations,
    collapsedDomainIds,
  );
  const memberResults = await Promise.all(
    seeds.map(async (seed) => ({
      seed,
      layout: seed.collapsed
        ? centeredGridLayout([])
        : await layoutDomainMembers(seed, relations),
    })),
  );
  const memberLayouts = new Map(
    memberResults.map(({ seed, layout }) => [seed.id, layout]),
  );
  const domains = memberResults.map(({ seed, layout }) =>
    domainFromMemberLayout(seed, layout),
  );
  const domainAggregates = aggregateRelationsByDomain(relations, entityDomain);
  const domainNodes = domains.map((domain) => ({
    id: domain.id,
    width: domain.width,
    height: domain.height,
  }));
  const domainEdges = domainLayoutEdges(domainAggregates);
  const packedDomainLayout = compactDomainLayout(domains, domainAggregates);
  let domainLayout = packedDomainLayout;
  if (domains.length > 1 && domains.length < 5 && domainEdges.length > 0) {
    try {
      domainLayout = await runLayeredLayout({
        id: "code-domains",
        nodes: domainNodes,
        edges: domainEdges,
        direction: "RIGHT",
        nodeSpacing: DOMAIN_GAP,
        layerSpacing: DOMAIN_LAYER_GAP,
      });
    } catch (_error) {
      domainLayout = packedDomainLayout;
    }
  }
  const positions = new Map<string, { x: number; y: number }>();

  for (const domain of domains) {
    domain.position = domainLayout.positions.get(domain.id) ?? { x: 0, y: 0 };
    positionMembers(
      positions,
      domain,
      memberLayouts.get(domain.id) ?? centeredGridLayout([]),
    );
  }

  return {
    positions,
    domains,
    entityDomain,
    version: "elk",
    key: graphKey(entities, relations, collapsedDomainIds),
  };
}
