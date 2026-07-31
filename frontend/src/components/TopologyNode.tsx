import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Maximize2, Minimize2, Minus, Plus } from "lucide-react";
import type { MouseEvent, PointerEvent } from "react";
import type { MonitorNode } from "../types";

export type TopologyNodeData = {
  monitor: MonitorNode;
  selected: boolean;
  related: boolean;
  dimmed: boolean;
  activity: "source" | "target" | null;
  collapsible?: boolean;
  expanded?: boolean;
  toggleAll?: boolean;
  onToggleExpanded?: (id: string) => void;
};

export type TopologyFlowNode = Node<TopologyNodeData, "topology">;

const handles = [
  ["left-in", Position.Left, "target"],
  ["left-out", Position.Left, "source"],
  ["right-in", Position.Right, "target"],
  ["right-out", Position.Right, "source"],
  ["top-in", Position.Top, "target"],
  ["top-out", Position.Top, "source"],
  ["bottom-in", Position.Bottom, "target"],
  ["bottom-out", Position.Bottom, "source"],
] as const;

export function TopologyNode({ data }: NodeProps<TopologyFlowNode>) {
  const {
    monitor,
    selected,
    related,
    dimmed,
    activity,
    collapsible,
    expanded,
    toggleAll,
    onToggleExpanded,
  } = data;
  const Icon = monitor.icon;
  const stopTogglePointer = (event: PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };
  const toggleExpanded = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onToggleExpanded?.(monitor.id);
  };

  return (
    <article
      className={[
        "topology-node",
        monitor.presentation ? `is-${monitor.presentation}` : "",
        `is-${monitor.status}`,
        collapsible ? "is-collapsible" : "",
        selected ? "is-selected" : "",
        related ? "is-related" : "",
        dimmed ? "is-dimmed" : "",
        activity ? `is-active-${activity}` : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={`${monitor.title}，${monitor.subtitle}`}
    >
      {handles.map(([id, position, type]) => (
        <Handle
          id={id}
          key={id}
          position={position}
          type={type}
          className="topology-handle"
        />
      ))}

      <div className="topology-node__icon" aria-hidden="true">
        <Icon size={19} strokeWidth={1.8} />
      </div>

      <div className="topology-node__copy">
        <span className="topology-node__category">{monitor.category}</span>
        <strong>{monitor.title}</strong>
        <span className="topology-node__subtitle">{monitor.subtitle}</span>
      </div>

      {monitor.metric && (
        <div className="topology-node__metric">
          <strong>{monitor.metric}</strong>
          <span>{monitor.metricLabel}</span>
        </div>
      )}

      {Boolean(monitor.statusCounts?.abnormal) && (
        <span
          className="topology-node__fault-count"
          title={`${monitor.statusCounts?.abnormal} 个已确认故障节点`}
        >
          {monitor.statusCounts?.abnormal}
        </span>
      )}

      {collapsible && (
        <button
          className="topology-node__collapse nodrag nopan"
          type="button"
          aria-label={
            toggleAll
              ? expanded
                ? "收起全部模块"
                : "展示全部模块"
              : expanded
              ? `收起 ${monitor.title} 下级节点`
              : `展开 ${monitor.title} 下级节点`
          }
          title={
            toggleAll
              ? expanded
                ? "收起全部模块"
                : "展示全部模块"
              : expanded
                ? "收起下级节点"
                : "展开下级节点"
          }
          onPointerDown={stopTogglePointer}
          onClick={toggleExpanded}
        >
          {toggleAll ? (
            expanded ? (
              <Minimize2 size={12} strokeWidth={2.2} />
            ) : (
              <Maximize2 size={12} strokeWidth={2.2} />
            )
          ) : expanded ? (
            <Minus size={12} strokeWidth={2.2} />
          ) : (
            <Plus size={12} strokeWidth={2.2} />
          )}
        </button>
      )}

      <span className="topology-node__status" aria-hidden="true" />
    </article>
  );
}
