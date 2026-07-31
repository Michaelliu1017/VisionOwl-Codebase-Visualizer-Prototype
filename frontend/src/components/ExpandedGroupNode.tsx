import {
  Handle,
  Position,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { Minus } from "lucide-react";
import type { MouseEvent, PointerEvent } from "react";
import type { MonitorNode } from "../types";

export type ExpandedGroupNodeData = {
  monitor: MonitorNode;
  selected: boolean;
  related: boolean;
  dimmed: boolean;
  activity: "source" | "target" | null;
  onCollapse: (id: string) => void;
};

export type ExpandedGroupFlowNode = Node<
  ExpandedGroupNodeData,
  "expandedGroup"
>;

export function ExpandedGroupNode({
  data,
}: NodeProps<ExpandedGroupFlowNode>) {
  const {
    monitor,
    selected,
    related,
    dimmed,
    activity,
    onCollapse,
  } = data;
  const Icon = monitor.icon;
  const stopPointer = (event: PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };
  const collapse = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onCollapse(monitor.id);
  };

  return (
    <section
      className={[
        "expanded-group",
        `is-${monitor.status}`,
        selected ? "is-selected" : "",
        related ? "is-related" : "",
        dimmed ? "is-dimmed" : "",
        activity ? `is-active-${activity}` : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={`${monitor.title}，已展开 ${monitor.memberCount ?? 0} 个成员`}
    >
      <Handle
        id="top-in"
        type="target"
        position={Position.Top}
        className="topology-handle"
      />
      <Handle
        id="top-out"
        type="source"
        position={Position.Top}
        className="topology-handle"
      />
      <Handle
        id="bottom-in"
        type="target"
        position={Position.Bottom}
        className="topology-handle"
      />
      <Handle
        id="bottom-out"
        type="source"
        position={Position.Bottom}
        className="topology-handle"
      />

      <header className="expanded-group__header">
        <div className="expanded-group__identity">
          <span className="expanded-group__icon" aria-hidden="true">
            <Icon size={14} strokeWidth={1.8} />
          </span>
          <div>
            <span>{monitor.category}</span>
            <strong>{monitor.title}</strong>
            <small>{monitor.memberCount ?? 0} 个成员</small>
          </div>
        </div>

        {Boolean(monitor.statusCounts?.abnormal) && (
          <span className="expanded-group__fault">
            {monitor.statusCounts?.abnormal} 个故障
          </span>
        )}

        <button
          className="expanded-group__collapse nodrag nopan"
          type="button"
          aria-label={`收起 ${monitor.title} 下级节点`}
          title="收起下级节点"
          onPointerDown={stopPointer}
          onClick={collapse}
        >
          <Minus size={12} strokeWidth={2.2} />
        </button>
      </header>
    </section>
  );
}
