import {
  EdgeLabelRenderer,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";

export type SimulationEdgeData = {
  label: string;
  pulse: boolean;
  labelX?: number;
  labelY?: number;
};

export type SimulationFlowEdge = Edge<SimulationEdgeData, "simulation">;

export function SimulationEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerStart,
  markerEnd,
  data,
}: EdgeProps<SimulationFlowEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 18,
    offset: 24,
  });

  return (
    <>
      <path
        id={id}
        d={path}
        markerStart={markerStart}
        markerEnd={markerEnd}
        pathLength={100}
        className="vision-simulation-edge__base"
      />
      <path
        d={path}
        pathLength={100}
        className="vision-simulation-edge__glow"
      />
      {data?.pulse && (
        <path
          d={path}
          pathLength={100}
          className="vision-simulation-edge__pulse"
        />
      )}
      {data?.label && (
        <EdgeLabelRenderer>
          <span
            className="vision-simulation-edge__label"
            style={{
              transform: `translate(-50%, -50%) translate(${
                data.labelX ?? labelX
              }px, ${data.labelY ?? labelY}px)`,
            }}
          >
            {data.label}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
