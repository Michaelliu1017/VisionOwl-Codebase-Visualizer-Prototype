import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { HealthState } from "../types";

export type TreeJunctionNodeData = {
  status: HealthState;
};

export type TreeJunctionFlowNode = Node<
  TreeJunctionNodeData,
  "treeJunction"
>;

export function TreeJunctionNode({
  data,
}: NodeProps<TreeJunctionFlowNode>) {
  return (
    <span
      className={`tree-junction is-${data.status}`}
      aria-hidden="true"
    >
      <Handle
        id="top-in"
        position={Position.Top}
        type="target"
        className="topology-handle"
      />
      <Handle
        id="bottom-out"
        position={Position.Bottom}
        type="source"
        className="topology-handle"
      />
    </span>
  );
}
