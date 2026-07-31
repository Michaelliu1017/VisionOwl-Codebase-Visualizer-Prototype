import {
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import { ArrowLeft, Wifi } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityEdge,
  type ActivityEdgeData,
} from "./components/ActivityEdge";
import { AiChatPlaceholder } from "./components/AiChatPlaceholder";
import { EventTimeline } from "./components/EventTimeline";
import {
  ExpandedGroupNode,
  type ExpandedGroupFlowNode,
} from "./components/ExpandedGroupNode";
import { MetricStrip } from "./components/MetricStrip";
import { ModeSwitch } from "./components/ModeSwitch";
import {
  NodeInspector,
  type ProbeAlertItem,
} from "./components/NodeInspector";
import {
  TopologyNode,
  type TopologyNodeData,
} from "./components/TopologyNode";
import {
  SystemGroupNode,
  type SystemGroupFlowNode,
} from "./components/SystemGroupNode";
import {
  TreeJunctionNode,
  type TreeJunctionFlowNode,
} from "./components/TreeJunctionNode";
import {
  buildOnlineTreeGraph,
  type GroupExpansionState,
} from "./online-tree-layout";
import { iconForNode } from "./node-icons";
import type {
  EdgeFlow,
  MonitorEvent,
  MonitorMode,
  MonitorNode,
} from "./types";
import { useMonitorRuntime } from "./useMonitorRuntime";
import type { VisionWorkspace } from "./App";
import { WorkspaceSwitch } from "./components/WorkspaceSwitch";

const nodeTypes = {
  topology: TopologyNode,
  systemGroup: SystemGroupNode,
  treeJunction: TreeJunctionNode,
  expandedGroup: ExpandedGroupNode,
};
const edgeTypes = { activity: ActivityEdge };

function getEventFlow(event: MonitorEvent): EdgeFlow {
  switch (event.kind) {
    case "probe-response":
    case "report-upload":
    case "report-local":
    case "report-sls":
    case "diagnosis-updated":
    case "health-updated":
      return "report";
    case "probe-register":
    case "agent-cached":
    case "probe-fetch":
    case "task-saved":
      return "control";
    default:
      return "task";
  }
}

function MonitorWorkspace({
  onViewChange,
}: {
  onViewChange: (view: VisionWorkspace) => void;
}) {
  const { fitView } = useReactFlow();
  const [mode, setMode] = useState<MonitorMode>("online");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedWorkerGroups, setExpandedWorkerGroups] =
    useState<GroupExpansionState>({});
  const [expandedAgentGroups, setExpandedAgentGroups] =
    useState<GroupExpansionState>({});
  const [expandedProbeGroups, setExpandedProbeGroups] =
    useState<GroupExpansionState>({});
  const [chatCollapsed, setChatCollapsed] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 1100px)").matches,
  );
  const simulation = useMonitorRuntime(mode);
  const incident = simulation.incident;
  const onlineGroupIds = useMemo(() => {
    const byType = (entityType: string) =>
      simulation.nodes
        .filter((node) => node.entityType === entityType)
        .map((node) => node.id);

    return {
      workers: byType("synthetics.worker.group"),
      agents: byType("synthetics.agent_rest.group"),
      probes: byType("synthetics.probe.group"),
    };
  }, [simulation.nodes]);
  const allOnlineGroupsExpanded =
    onlineGroupIds.workers.length +
      onlineGroupIds.agents.length +
      onlineGroupIds.probes.length >
      0 &&
    onlineGroupIds.workers.every(
      (id) => expandedWorkerGroups[id] ?? false,
    ) &&
    onlineGroupIds.agents.every(
      (id) => expandedAgentGroups[id] ?? true,
    ) &&
    onlineGroupIds.probes.every(
      (id) => expandedProbeGroups[id] ?? false,
    );
  const overviewGraph = useMemo(
    () =>
      mode === "online" && !incident
        ? buildOnlineTreeGraph(
            simulation.nodes,
            simulation.edges,
            expandedWorkerGroups,
            expandedAgentGroups,
            expandedProbeGroups,
          )
        : {
            nodes: incident?.graph.nodes ?? simulation.nodes,
            edges: incident?.graph.edges ?? simulation.edges,
          },
    [
      expandedWorkerGroups,
      expandedAgentGroups,
      expandedProbeGroups,
      incident,
      mode,
      simulation.edges,
      simulation.nodes,
    ],
  );
  const activeNodes = overviewGraph.nodes;
  const activeEdges = overviewGraph.edges;
  const probeAlerts = useMemo<ProbeAlertItem[]>(() => {
    const alerts: ProbeAlertItem[] = [];
    const seen = new Set<string>();

    simulation.nodes.forEach((group) => {
      if (group.entityType !== "synthetics.probe.group") return;

      if (
        group.ordinaryProbeStatus &&
        group.ordinaryProbeStatus !== "healthy"
      ) {
        const affectedCount =
          group.ordinaryProbeStatus === "error"
            ? (group.statusCounts?.abnormal ?? 1)
            : group.ordinaryProbeStatus === "warning"
              ? (group.statusCounts?.suspected ?? 1)
              : (group.statusCounts?.insufficient_evidence ?? 1);
        const nodeId = `${group.id}-ordinary`;
        alerts.push({
          groupId: group.id,
          affectedCount: Math.max(affectedCount, 1),
          node: {
            id: nodeId,
            title: `${group.title.replace(/\s*GoProbe$/, "")}普通探针组`,
            subtitle:
              group.ordinaryProbeStatus === "warning"
                ? `${Math.max(affectedCount, 1)} 个普通探针受到影响`
                : group.ordinaryProbeStatus === "error"
                  ? `${Math.max(affectedCount, 1)} 个普通探针已确认故障`
                  : `${Math.max(affectedCount, 1)} 个普通探针证据不足`,
            category: "ORDINARY PROBE GROUP",
            entityType: "synthetics.probe.ordinary.group",
            region: group.region,
            status: group.ordinaryProbeStatus,
            icon: iconForNode({
              entityType: "synthetics.probe.ordinary.group",
            }),
            position: { x: 0, y: 0 },
            details: [
              { label: "所属分组", value: group.title },
              {
                label: "受影响数量",
                value: String(Math.max(affectedCount, 1)),
                tone: group.ordinaryProbeStatus,
              },
              { label: "探针类型", value: "普通探针" },
              {
                label: "地域",
                value: group.region ?? "unknown",
                mono: true,
              },
            ],
            diagnosis: group.diagnosis,
            aggregateId: group.id,
          },
        });
        seen.add(nodeId);
      }

      (group.idcProbes ?? []).forEach((probe) => {
        if (probe.status === "healthy" || seen.has(probe.id)) return;
        alerts.push({
          groupId: group.id,
          affectedCount: 1,
          node: {
            ...probe,
            category: "IDC PROBE",
            entityType: "synthetics.probe.idc",
            region: group.region,
            icon: iconForNode({ entityType: "synthetics.probe.idc" }),
            position: { x: 0, y: 0 },
            details: [
              { label: "所属分组", value: group.title },
              ...probe.details,
            ],
            diagnosis:
              probe.status === "error"
                ? {
                    status: "abnormal",
                    statusLabel: "已确认故障",
                    confidence: "high",
                    boundary: "单探针节点故障",
                  }
                : group.diagnosis,
            aggregateId: group.id,
          },
        });
        seen.add(probe.id);
      });
    });

    simulation.nodes.forEach((node) => {
      const isProbe =
        node.category === "PROBE" ||
        (node.entityType?.includes("probe") &&
          !node.entityType.endsWith(".group"));
      if (
        !isProbe ||
        node.status === "healthy" ||
        seen.has(node.id)
      ) {
        return;
      }
      alerts.push({ node, affectedCount: 1 });
      seen.add(node.id);
    });

    const statusRank = { error: 0, warning: 1, offline: 2, healthy: 3 };
    return alerts.sort(
      (left, right) =>
        statusRank[left.node.status] - statusRank[right.node.status],
    );
  }, [simulation.nodes]);

  const selectedNode =
    probeAlerts.find((item) => item.node.id === selectedId)?.node ??
    activeNodes.find((node) => node.id === selectedId) ??
    null;

  const refitTopology = useCallback(() => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        void fitView({ padding: 0.08, maxZoom: 0.9, duration: 260 });
      });
    });
  }, [fitView]);

  const handleToggleWorkerGroup = useCallback(
    (workerGroupId: string) => {
      setExpandedWorkerGroups((current) => ({
        ...current,
        [workerGroupId]: !(current[workerGroupId] ?? false),
      }));
      setSelectedId(null);
      refitTopology();
    },
    [refitTopology],
  );

  const handleToggleAgentGroup = useCallback((agentGroupId: string) => {
    setExpandedAgentGroups((current) => ({
      ...current,
      [agentGroupId]: !(current[agentGroupId] ?? true),
    }));
    setSelectedId(null);
    refitTopology();
  }, [refitTopology]);

  const handleToggleProbeGroup = useCallback((probeGroupId: string) => {
    setExpandedProbeGroups((current) => ({
      ...current,
      [probeGroupId]: !(current[probeGroupId] ?? false),
    }));
    setSelectedId(null);
    refitTopology();
  }, [refitTopology]);

  const handleToggleAllGroups = useCallback(() => {
    const expand = !allOnlineGroupsExpanded;
    setExpandedWorkerGroups(
      Object.fromEntries(
        onlineGroupIds.workers.map((id) => [id, expand]),
      ),
    );
    setExpandedAgentGroups(
      Object.fromEntries(
        onlineGroupIds.agents.map((id) => [id, expand]),
      ),
    );
    setExpandedProbeGroups(
      Object.fromEntries(
        onlineGroupIds.probes.map((id) => [id, expand]),
      ),
    );
    setSelectedId(null);
    refitTopology();
  }, [
    allOnlineGroupsExpanded,
    onlineGroupIds,
    refitTopology,
  ]);

  const handleSelectProbe = useCallback(
    (item: ProbeAlertItem) => {
      if (item.groupId) {
        setExpandedProbeGroups((current) => ({
          ...current,
          [item.groupId!]: true,
        }));
      }
      setSelectedId(item.node.id);
      refitTopology();
    },
    [refitTopology],
  );

  const relatedIds = useMemo(() => {
    if (!selectedId) return new Set<string>();
    if (incident) return new Set(activeNodes.map((node) => node.id));
    const ids = new Set<string>([selectedId]);

    if (mode === "online") {
      const selected = activeNodes.find((node) => node.id === selectedId);
      if (selected?.region) {
        activeNodes.forEach((node) => {
          if (node.region === selected.region) ids.add(node.id);
        });
        ids.add("online-global-root");
        return ids;
      }
    }

    activeEdges.forEach((edge) => {
      if (edge.source === selectedId) ids.add(edge.target);
      if (edge.target === selectedId) ids.add(edge.source);
    });
    return ids;
  }, [activeEdges, activeNodes, incident, mode, selectedId]);

  const flowNodes = useMemo<
    Array<
      | Node<TopologyNodeData, "topology">
      | SystemGroupFlowNode
      | TreeJunctionFlowNode
      | ExpandedGroupFlowNode
    >
  >(() => {
    const topologyNodes = activeNodes.map<
      | Node<TopologyNodeData, "topology">
      | TreeJunctionFlowNode
      | ExpandedGroupFlowNode
    >((monitor) => {
        const matchesEventNode = (eventNodeId: string) =>
          monitor.id === eventNodeId ||
          monitor.aggregateId === eventNodeId;
        const isEventSource =
          !incident &&
          matchesEventNode(simulation.currentEvent.sourceId);
        const isEventTarget =
          !incident &&
          matchesEventNode(simulation.currentEvent.targetId);
        const activity = isEventSource
          ? ("source" as const)
          : isEventTarget
            ? ("target" as const)
            : null;
        const selected = selectedId === monitor.id;
        const related = Boolean(
          selectedId && relatedIds.has(monitor.id),
        );
        const dimmed = Boolean(
          selectedId &&
            !incident &&
            !relatedIds.has(monitor.id) &&
            !activity,
        );

        if (monitor.presentation === "junction") {
          return {
            id: monitor.id,
            type: "treeJunction",
            position: monitor.position,
            draggable: false,
            selectable: false,
            focusable: false,
            data: { status: monitor.status },
          };
        }

        if (
          monitor.presentation === "expanded-group" &&
          monitor.groupSize
        ) {
          const onCollapse =
            monitor.entityType === "synthetics.worker.group"
              ? handleToggleWorkerGroup
              : monitor.entityType === "synthetics.probe.group"
                ? handleToggleProbeGroup
                : handleToggleAgentGroup;

          return {
            id: monitor.id,
            type: "expandedGroup",
            position: monitor.position,
            draggable: false,
            selectable: true,
            initialWidth: monitor.groupSize.width,
            initialHeight: monitor.groupSize.height,
            style: {
              width: monitor.groupSize.width,
              height: monitor.groupSize.height,
              zIndex: 2,
            },
            data: {
              monitor,
              selected,
              related,
              dimmed,
              activity,
              onCollapse,
            },
          };
        }

        return {
          id: monitor.id,
          type: "topology",
          position: monitor.position,
          draggable: false,
          selectable: true,
          data: {
            monitor,
            selected,
            related,
            dimmed,
            activity,
            collapsible:
              mode === "online" &&
              !incident &&
              (monitor.id === "online-global-root" ||
                monitor.entityType === "synthetics.worker.group" ||
                monitor.entityType === "synthetics.agent_rest.group" ||
                monitor.entityType === "synthetics.probe.group"),
            expanded:
              monitor.id === "online-global-root"
                ? allOnlineGroupsExpanded
                : monitor.entityType === "synthetics.worker.group"
                ? (expandedWorkerGroups[monitor.id] ?? false)
                : monitor.entityType === "synthetics.probe.group"
                ? (expandedProbeGroups[monitor.id] ?? false)
                : (expandedAgentGroups[monitor.id] ?? true),
            toggleAll: monitor.id === "online-global-root",
            onToggleExpanded:
              monitor.id === "online-global-root"
                ? handleToggleAllGroups
                : monitor.entityType === "synthetics.worker.group"
                ? handleToggleWorkerGroup
                : monitor.entityType === "synthetics.probe.group"
                ? handleToggleProbeGroup
                : handleToggleAgentGroup,
          },
        };
      });

    if (mode !== "local" || incident) return topologyNodes;

    const redisGroup: SystemGroupFlowNode = {
      id: "redis-system-group",
      type: "systemGroup",
      position: { x: 210, y: 195 },
      draggable: false,
      selectable: false,
      focusable: false,
      initialWidth: 898,
      initialHeight: 180,
      style: {
        width: 898,
        height: 180,
        zIndex: 0,
      },
      data: {
        eyebrow: "SYSTEM BOUNDARY",
        title: "Redis",
        subtitle: "共享运行时数据",
        modules: ["TASK DETAIL", "EXECUTION QUEUE", "AGENT CACHE"],
      },
    };
    return [redisGroup, ...topologyNodes];
  }, [
    activeNodes,
    expandedWorkerGroups,
    expandedAgentGroups,
    expandedProbeGroups,
    allOnlineGroupsExpanded,
    handleToggleAllGroups,
    handleToggleWorkerGroup,
    handleToggleAgentGroup,
    handleToggleProbeGroup,
    incident,
    mode,
    relatedIds,
    selectedId,
    simulation.currentEvent,
  ]);

  const flowEdges = useMemo<Edge<ActivityEdgeData, "activity">[]>(
    () =>
      activeEdges.map((edge) => {
        const connected =
          selectedId === edge.source || selectedId === edge.target;
        const related =
          !selectedId ||
          (relatedIds.has(edge.source) && relatedIds.has(edge.target));
        const active = !incident && simulation.currentEvent.edgeId === edge.id;

        return {
          ...edge,
          type: "activity",
          sourceHandle: edge.sourceHandle ?? "right-out",
          targetHandle: edge.targetHandle ?? "left-in",
          focusable: false,
          selectable: false,
          data: {
            label: edge.label,
            active,
            direction: active
              ? simulation.currentEvent.direction
              : ("forward" as const),
            severity: active
              ? simulation.currentEvent.severity
              : (edge.severity ?? "info"),
            flow: active
              ? getEventFlow(simulation.currentEvent)
              : (edge.flow ?? "control"),
            selected: Boolean(selectedId && connected),
            dimmed: Boolean(selectedId && !related && !incident),
            routePoints: edge.routePoints,
            labelPosition: edge.labelPosition,
          },
        };
      }),
    [
      activeEdges,
      incident,
      relatedIds,
      selectedId,
      simulation.currentEvent,
    ],
  );

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setSelectedId((current) => (current === node.id ? null : node.id));
    },
    [],
  );

  const handleModeChange = useCallback(
    (nextMode: MonitorMode) => {
      if (nextMode === mode) return;
      simulation.closeIncident();
      setSelectedId(null);
      setMode(nextMode);
    },
    [mode, simulation],
  );

  const handleOpenIncident = useCallback(
    async (id: string) => {
      const result = await simulation.openIncident(id);
      if (result) setSelectedId("incident-probe");
    },
    [simulation],
  );

  const handleCloseInspector = useCallback(() => {
    if (incident) {
      simulation.closeIncident();
      setSelectedId(incident.affectedGroupId);
      return;
    }
    setSelectedId(null);
  }, [incident, simulation]);

  const handleBackToOverview = useCallback(() => {
    const affectedGroupId = incident?.affectedGroupId ?? null;
    simulation.closeIncident();
    setSelectedId(affectedGroupId);
  }, [incident, simulation]);

  const onlineSubtitle = simulation.mocked
    ? `${simulation.workspace ?? "workspace"} · Mock UModel`
    : simulation.workspace ?? "UModel";

  return (
    <main className={`monitor-app is-mode-${mode}`}>
      <header className="app-header">
        <div className="brand">
          <img src="/hackowl.png" alt="" />
          <div>
            <strong>VisionOwl</strong>
            <span>
              {mode === "online" ? "线上拨测全局健康" : "M5 拨测闭环"}
            </span>
          </div>
        </div>

        <div className="header-status">
          <WorkspaceSwitch value="runtime" onChange={onViewChange} />
          <ModeSwitch mode={mode} onChange={handleModeChange} />
          <span className="environment-badge">
            {mode === "online" ? onlineSubtitle : "M5 LOCAL"}
          </span>
          <span
            className={`feed-status ${
              simulation.connected ? "" : "is-disconnected"
            }`}
          >
            <Wifi size={14} />
            {simulation.connected ? "LIVE FEED" : "RECONNECTING"}
          </span>
          <span className="update-stamp">
            最近刷新 {simulation.lastUpdatedAt}
          </span>
        </div>
      </header>

      <MetricStrip
        metrics={simulation.metrics}
        mode={mode}
        live={simulation.connected}
        mocked={simulation.mocked}
      />

      <section
        className={`monitor-workspace ${
          chatCollapsed ? "is-chat-collapsed" : ""
        }`}
      >
        <div className="topology-canvas" aria-label="拨测闭环拓扑图">
          <div className="canvas-heading">
            <div>
              {incident && (
                <button
                  className="canvas-back-button"
                  type="button"
                  onClick={handleBackToOverview}
                  aria-label="返回线上全局图"
                  title="返回全局图"
                >
                  <ArrowLeft size={14} />
                </button>
              )}
              <span>{incident ? "INCIDENT FOCUS" : mode === "online" ? "GLOBAL UMODEL" : "LIVE TOPOLOGY"}</span>
              <strong>
                {incident
                  ? `${incident.id} · ${incident.boundary}`
                  : mode === "online"
                    ? "Worker → Agent-Rest → GoProbe"
                    : "任务写入 → Worker 投放 → Probe 拉取 → 探测 → 报告"}
              </strong>
            </div>
            <div className={`canvas-legend ${mode === "online" ? "is-health" : ""}`}>
              {mode === "online" ? (
                <>
                  <span><i className="is-healthy-state" />正常</span>
                  <span><i className="is-warning-state" />受影响</span>
                  <span><i className="is-error-state" />故障</span>
                </>
              ) : (
                <>
                  <span><i className="is-task-flow" />任务</span>
                  <span><i className="is-report-flow" />报告</span>
                  <span><i className="is-control-flow" />拉取/缓存</span>
                </>
              )}
            </div>
          </div>

          <ReactFlow
            key={`${mode}-${incident?.id ?? "overview"}`}
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodeClick={handleNodeClick}
            onPaneClick={() => setSelectedId(null)}
            fitView
            fitViewOptions={{
              padding: incident ? 0.12 : mode === "online" ? 0.08 : 0.06,
              maxZoom: incident ? 0.96 : 0.9,
            }}
            minZoom={0.3}
            maxZoom={1.6}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            panOnScroll
            zoomOnDoubleClick={false}
            proOptions={{ hideAttribution: true }}
          >
            <Controls
              position="bottom-left"
              showInteractive={false}
              fitViewOptions={{ padding: 0.08, maxZoom: 0.9 }}
            />
          </ReactFlow>
        </div>

        <AiChatPlaceholder
          collapsed={chatCollapsed}
          node={selectedNode as MonitorNode | null}
          incident={incident}
          onToggle={() => setChatCollapsed((current) => !current)}
        />

        <NodeInspector
          node={selectedNode as MonitorNode | null}
          probeAlerts={probeAlerts}
          event={simulation.currentEvent}
          mode={mode}
          incident={incident}
          incidentLoading={simulation.incidentLoading}
          onOpenIncident={(id) => void handleOpenIncident(id)}
          onSelectProbe={handleSelectProbe}
          onClose={handleCloseInspector}
        />
      </section>

      <EventTimeline
        events={simulation.history}
        currentEvent={simulation.currentEvent}
      />
    </main>
  );
}

export function RuntimeWorkspace({
  onViewChange,
}: {
  onViewChange: (view: VisionWorkspace) => void;
}) {
  return (
    <ReactFlowProvider>
      <MonitorWorkspace onViewChange={onViewChange} />
    </ReactFlowProvider>
  );
}
