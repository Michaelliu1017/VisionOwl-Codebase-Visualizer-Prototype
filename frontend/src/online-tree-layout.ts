import { iconForNode } from "./node-icons";
import type {
  HealthState,
  MonitorEdge,
  MonitorNode,
  StatusCounts,
} from "./types";

const BRANCH_WIDTH = 620;
const BRANCH_STEP = 680;
const NODE_WIDTH = 188;
const ROOT_WIDTH = 220;
const INSTANCES_PER_ROW = 6;
const INSTANCE_WIDTH = 92;
const INSTANCE_STEP = 100;
const FIRST_GROUP_Y = 130;
const COLLAPSED_GROUP_HEIGHT = 78;
const GROUP_GAP = 46;
const FRAME_HEADER_HEIGHT = 58;
const COMPACT_NODE_HEIGHT = 50;
const MEMBER_ROW_STEP = 64;
const FRAME_BOTTOM_PADDING = 16;

export type GroupExpansionState = Record<string, boolean>;

export type OnlineTreeGraph = {
  nodes: MonitorNode[];
  edges: MonitorEdge[];
};

function isEntity(node: MonitorNode, suffix: string) {
  return node.entityType?.endsWith(suffix) ?? false;
}

function findRegionalNode(
  nodes: MonitorNode[],
  region: string | undefined,
  suffix: string,
) {
  return nodes.find(
    (node) => node.region === region && isEntity(node, suffix),
  );
}

function findEdge(
  edges: MonitorEdge[],
  source: string,
  target: string,
) {
  return edges.find(
    (edge) => edge.source === source && edge.target === target,
  );
}

function statusRank(status: HealthState) {
  switch (status) {
    case "error":
      return 3;
    case "warning":
      return 2;
    case "offline":
      return 1;
    default:
      return 0;
  }
}

function strongestStatus(nodes: MonitorNode[]): HealthState {
  return nodes.reduce<HealthState>(
    (current, node) =>
      statusRank(node.status) > statusRank(current)
        ? node.status
        : current,
    "healthy",
  );
}

function createInstanceNode(
  group: MonitorNode,
  worker: MonitorNode,
  index: number,
  position: { x: number; y: number },
): MonitorNode {
  const sequence = String(index + 1).padStart(2, "0");
  const status: HealthState =
    group.status === "offline" ? "offline" : "healthy";

  return {
    id: `${group.id}-instance-${sequence}`,
    title: `Agent-Rest ${sequence}`,
    subtitle: group.region ?? "online",
    category: "AGENT-REST INSTANCE",
    entityType: "synthetics.agent_rest",
    region: group.region,
    status,
    icon: iconForNode({ entityType: "synthetics.agent_rest" }),
    position,
    metric: status === "healthy" ? "UP" : "DOWN",
    metricLabel: "STATE",
    memberCount: 1,
    statusCounts: {
      healthy: status === "healthy" ? 1 : 0,
      suspected: 0,
      abnormal: 0,
      insufficient_evidence: 0,
    },
    details: [
      { label: "所属 Worker", value: worker.title },
      { label: "所属地域", value: group.region ?? "unknown", mono: true },
      { label: "实例序号", value: sequence, mono: true },
      { label: "展示来源", value: "聚合数据前端展开" },
    ],
    presentation: "compact",
    aggregateId: group.id,
  };
}

function createWorkerInstanceNode(
  group: MonitorNode,
  index: number,
  position: { x: number; y: number },
): MonitorNode {
  const sequence = String(index + 1).padStart(2, "0");
  const status: HealthState =
    group.status === "offline" ? "offline" : "healthy";

  return {
    id: `${group.id}-instance-${sequence}`,
    title: `Worker ${sequence}`,
    subtitle: group.region ?? "online",
    category: "WORKER INSTANCE",
    entityType: "synthetics.worker",
    region: group.region,
    status,
    icon: iconForNode({ entityType: "synthetics.worker" }),
    position,
    metric: status === "healthy" ? "UP" : "DOWN",
    metricLabel: "STATE",
    memberCount: 1,
    details: [
      { label: "所属集群", value: group.title },
      { label: "所属地域", value: group.region ?? "unknown", mono: true },
      { label: "实例序号", value: sequence, mono: true },
      { label: "展示来源", value: "聚合数据前端展开" },
    ],
    presentation: "compact",
    aggregateId: group.id,
  };
}

function createProbeMemberNodes(
  group: MonitorNode,
): MonitorNode[] {
  const idcProbes = group.idcProbes ?? [];
  const ordinaryCount = Math.max(
    (group.memberCount ?? idcProbes.length) - idcProbes.length,
    0,
  );
  const members: MonitorNode[] = [];

  if (ordinaryCount > 0) {
    const status = group.ordinaryProbeStatus ?? "healthy";
    members.push({
      id: `${group.id}-ordinary`,
      title: "普通探针组",
      subtitle: `${ordinaryCount.toLocaleString("en-US")} 个普通探针`,
      category: "ORDINARY PROBE GROUP",
      entityType: "synthetics.probe.ordinary.group",
      region: group.region,
      status,
      icon: iconForNode({ entityType: "synthetics.probe.ordinary.group" }),
      position: { x: 0, y: 0 },
      memberCount: ordinaryCount,
      details: [
        { label: "探针类型", value: "普通探针" },
        {
          label: "探针数量",
          value: ordinaryCount.toLocaleString("en-US"),
        },
        { label: "聚合规则", value: "所有非 IDC 探针合并展示" },
      ],
      presentation: "compact",
      aggregateId: group.id,
    });
  }

  idcProbes.forEach((probe) => {
    members.push({
      ...probe,
      category: "IDC PROBE",
      entityType: "synthetics.probe.idc",
      region: group.region,
      icon: iconForNode({ entityType: "synthetics.probe.idc" }),
      position: { x: 0, y: 0 },
      memberCount: 1,
      presentation: "compact",
      aggregateId: group.id,
    });
  });

  return members;
}

function rowCount(memberCount: number | undefined) {
  return Math.ceil(Math.max(memberCount ?? 1, 1) / INSTANCES_PER_ROW);
}

function expandedGroupHeight(memberCount: number) {
  return (
    FRAME_HEADER_HEIGHT +
    rowCount(memberCount) * COMPACT_NODE_HEIGHT +
    Math.max(rowCount(memberCount) - 1, 0) *
      (MEMBER_ROW_STEP - COMPACT_NODE_HEIGHT) +
    FRAME_BOTTOM_PADDING
  );
}

function layoutMembers(
  members: MonitorNode[],
  branchCenter: number,
  top: number,
) {
  return members.map((member, index) => {
    const row = Math.floor(index / INSTANCES_PER_ROW);
    const column = index % INSTANCES_PER_ROW;
    const rowSize = Math.min(
      INSTANCES_PER_ROW,
      members.length - row * INSTANCES_PER_ROW,
    );
    const rowWidth =
      rowSize * INSTANCE_WIDTH +
      Math.max(rowSize - 1, 0) * (INSTANCE_STEP - INSTANCE_WIDTH);
    const rowLeft = branchCenter - rowWidth / 2;

    return {
      ...member,
      position: {
        x: rowLeft + column * INSTANCE_STEP,
        y: top + row * MEMBER_ROW_STEP,
      },
    };
  });
}

function positionGroup(
  group: MonitorNode,
  options: {
    branchLeft: number;
    branchCenter: number;
    y: number;
    expanded: boolean;
    category: string;
    subtitle: string;
    memberCount: number;
  },
): MonitorNode {
  const {
    branchLeft,
    branchCenter,
    y,
    expanded,
    category,
    subtitle,
    memberCount,
  } = options;

  return {
    ...group,
    category,
    subtitle,
    position: expanded
      ? { x: branchLeft, y }
      : { x: branchCenter - NODE_WIDTH / 2, y },
    presentation: expanded ? "expanded-group" : "default",
    groupSize: expanded
      ? {
          width: BRANCH_WIDTH,
          height: expandedGroupHeight(memberCount),
        }
      : undefined,
  };
}

function createRootNode(
  nodes: MonitorNode[],
  workers: MonitorNode[],
  centerX: number,
): MonitorNode {
  const agentRests = nodes
    .filter((node) => isEntity(node, "agent_rest.group"))
    .reduce((total, node) => total + (node.memberCount ?? 0), 0);
  const probes = nodes
    .filter((node) => isEntity(node, "probe.group"))
    .reduce((total, node) => total + (node.memberCount ?? 0), 0);
  const statusCounts = nodes
    .filter((node) => isEntity(node, "probe.group"))
    .reduce<StatusCounts>(
      (result, node) => ({
        healthy: result.healthy + (node.statusCounts?.healthy ?? 0),
        suspected: result.suspected + (node.statusCounts?.suspected ?? 0),
        abnormal: result.abnormal + (node.statusCounts?.abnormal ?? 0),
        insufficient_evidence:
          result.insufficient_evidence +
          (node.statusCounts?.insufficient_evidence ?? 0),
      }),
      {
        healthy: 0,
        suspected: 0,
        abnormal: 0,
        insufficient_evidence: 0,
      },
    );

  return {
    id: "online-global-root",
    title: "线上拨测全局",
    subtitle: `${workers.length} 个地域分支`,
    category: "GLOBAL UMODEL",
    entityType: "synthetics.monitoring.system",
    status: strongestStatus(nodes),
    icon: iconForNode({ entityType: "synthetics.monitoring.system" }),
    position: { x: centerX - ROOT_WIDTH / 2, y: 0 },
    metric: String(probes.toLocaleString("en-US")),
    metricLabel: "PROBES",
    memberCount: workers.length,
    statusCounts,
    details: [
      { label: "地域分支", value: String(workers.length) },
      { label: "Worker 集群", value: String(workers.length) },
      { label: "Agent-Rest 实例", value: String(agentRests) },
      { label: "GoProbe", value: probes.toLocaleString("en-US") },
    ],
    presentation: "root",
  };
}

function cloneEdge(
  edge: MonitorEdge | undefined,
  fallback: MonitorEdge,
  overrides: Partial<MonitorEdge>,
): MonitorEdge {
  return {
    ...(edge ?? fallback),
    ...overrides,
  };
}

export function buildOnlineTreeGraph(
  sourceNodes: MonitorNode[],
  sourceEdges: MonitorEdge[],
  workerExpansion: GroupExpansionState,
  agentExpansion: GroupExpansionState,
  probeExpansion: GroupExpansionState,
): OnlineTreeGraph {
  const workers = sourceNodes
    .filter((node) => isEntity(node, "worker.group"))
    .sort((left, right) => left.position.y - right.position.y);

  if (workers.length === 0) {
    return { nodes: sourceNodes, edges: sourceEdges };
  }

  const workerY = FIRST_GROUP_Y;

  const firstCenter = BRANCH_WIDTH / 2;
  const lastCenter = firstCenter + (workers.length - 1) * BRANCH_STEP;
  const root = createRootNode(
    sourceNodes,
    workers,
    (firstCenter + lastCenter) / 2,
  );
  const nodes: MonitorNode[] = [root];
  const edges: MonitorEdge[] = [];

  workers.forEach((worker, workerIndex) => {
    const branchLeft = workerIndex * BRANCH_STEP;
    const branchCenter = branchLeft + BRANCH_WIDTH / 2;
    const agentGroup = findRegionalNode(
      sourceNodes,
      worker.region,
      "agent_rest.group",
    );
    const probeGroup = findRegionalNode(
      sourceNodes,
      worker.region,
      "probe.group",
    );

    const isWorkerExpanded = workerExpansion[worker.id] ?? false;
    const workerMembers = Array.from(
      { length: Math.max(worker.memberCount ?? 1, 1) },
      (_, index) =>
        createWorkerInstanceNode(worker, index, { x: 0, y: 0 }),
    );
    const positionedWorker = positionGroup(worker, {
      branchLeft,
      branchCenter,
      y: workerY,
      expanded: isWorkerExpanded,
      category: "WORKER GROUP",
      subtitle: isWorkerExpanded
        ? `${workerMembers.length} 个 Worker 实例`
        : `${workerMembers.length} 个 Worker，当前已合并`,
      memberCount: workerMembers.length,
    });
    nodes.push(positionedWorker);
    if (isWorkerExpanded) {
      nodes.push(
        ...layoutMembers(
          workerMembers,
          branchCenter,
          workerY + FRAME_HEADER_HEIGHT,
        ),
      );
    }
    edges.push({
      id: `global-${worker.id}`,
      source: root.id,
      target: worker.id,
      label: "",
      flow: "control",
      severity: worker.status === "error" ? "error" : "info",
      sourceHandle: "bottom-out",
      targetHandle: "top-in",
    });

    if (!agentGroup) return;

    const workerToAgent = findEdge(
      sourceEdges,
      worker.id,
      agentGroup.id,
    );
    const isAgentExpanded = agentExpansion[agentGroup.id] ?? true;
    const workerBlockHeight = isWorkerExpanded
      ? expandedGroupHeight(workerMembers.length)
      : COLLAPSED_GROUP_HEIGHT;
    const agentGroupY = workerY + workerBlockHeight + GROUP_GAP;
    const agentMembers = Array.from(
      { length: Math.max(agentGroup.memberCount ?? 1, 1) },
      (_, index) =>
        createInstanceNode(agentGroup, worker, index, { x: 0, y: 0 }),
    );
    const positionedAgentGroup = positionGroup(agentGroup, {
      branchLeft,
      branchCenter,
      y: agentGroupY,
      expanded: isAgentExpanded,
      category: "AGENT-REST GROUP",
      subtitle: isAgentExpanded
        ? `${agentMembers.length} 个 Agent-Rest 实例`
        : `${agentMembers.length} 个 Agent-Rest，当前已合并`,
      memberCount: agentMembers.length,
    });
    nodes.push(positionedAgentGroup);
    if (isAgentExpanded) {
      nodes.push(
        ...layoutMembers(
          agentMembers,
          branchCenter,
          agentGroupY + FRAME_HEADER_HEIGHT,
        ),
      );
    }
    edges.push(
      cloneEdge(
        workerToAgent,
        {
          id: `${worker.id}-${agentGroup.id}`,
          source: worker.id,
          target: agentGroup.id,
          label: "任务调度",
        },
        {
          source: worker.id,
          target: agentGroup.id,
          sourceHandle: "bottom-out",
          targetHandle: "top-in",
        },
      ),
    );

    if (!probeGroup) return;

    const agentToProbe = findEdge(
      sourceEdges,
      agentGroup.id,
      probeGroup.id,
    );
    const isProbeExpanded = probeExpansion[probeGroup.id] ?? false;
    const agentBlockHeight = isAgentExpanded
      ? expandedGroupHeight(agentMembers.length)
      : COLLAPSED_GROUP_HEIGHT;
    const probeY = agentGroupY + agentBlockHeight + GROUP_GAP;
    const probeMembers = createProbeMemberNodes(probeGroup);
    const probeDetails = probeGroup.details.some(
      (detail) => detail.label === "运行数据",
    )
      ? probeGroup.details
      : [
          ...probeGroup.details,
          { label: "运行数据", value: "拨测报告 + online 心跳" },
        ];
    const positionedProbe = positionGroup(
      {
        ...probeGroup,
        details: probeDetails,
      },
      {
        branchLeft,
        branchCenter,
        y: probeY,
        expanded: isProbeExpanded,
        category: "GOPROBE GROUP",
        subtitle: isProbeExpanded
          ? `${probeGroup.idcProbes?.length ?? 0} 个 IDC 探针 + 普通探针组`
          : `${probeGroup.memberCount ?? 0} 个探针，当前已合并`,
        memberCount: Math.max(probeMembers.length, 1),
      },
    );

    nodes.push(positionedProbe);
    if (isProbeExpanded) {
      nodes.push(
        ...layoutMembers(
          probeMembers,
          branchCenter,
          probeY + FRAME_HEADER_HEIGHT,
        ),
      );
    }
    edges.push(
      cloneEdge(
        agentToProbe,
        {
          id: `${agentGroup.id}-${probeGroup.id}`,
          source: agentGroup.id,
          target: probeGroup.id,
          label: "拉取 / 上报",
        },
        {
          source: agentGroup.id,
          target: probeGroup.id,
          sourceHandle: "bottom-out",
          targetHandle: "top-in",
        },
      ),
    );
  });

  return { nodes, edges };
}
