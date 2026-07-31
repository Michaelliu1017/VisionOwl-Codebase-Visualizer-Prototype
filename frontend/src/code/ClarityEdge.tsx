import {
  EdgeLabelRenderer,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";

export type ClarityEdgeData = {
  label?: string;
  emphasized: boolean;
  dimmed: boolean;
  background: boolean;
  pending: boolean;
  lane: number;
  pulse: boolean;
  aggregate: boolean;
  execution: boolean;
  labelX?: number;
  labelY?: number;
};

export type ClarityFlowEdge = Edge<ClarityEdgeData, "clarity">;

export function ClarityEdge({
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
}: EdgeProps<ClarityFlowEdge>) {
  const vertical =
    Math.abs(targetY - sourceY) > Math.abs(targetX - sourceX);
  const lane = data?.lane ?? 0;
  const pathLaneOffset = lane * 22;
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 18,
    offset: 28,
    centerX:
      (sourceX + targetX) / 2 + (vertical ? pathLaneOffset : 0),
    centerY:
      (sourceY + targetY) / 2 + (vertical ? 0 : pathLaneOffset),
  });
  const labelX =
    data?.labelX ??
    (sourceX + targetX) / 2 +
      (vertical ? (lane === 0 ? 20 : lane * 68) : 0);
  const labelY =
    data?.labelY ??
    (sourceY + targetY) / 2 + (vertical ? 0 : lane * 40);
  const stateClassName = [
    data?.background ? "is-background" : "",
    data?.emphasized ? "is-emphasized" : "",
    data?.pending ? "is-pending" : "",
    data?.dimmed ? "is-dimmed" : "",
    data?.aggregate ? "is-aggregate" : "",
    data?.execution ? "is-execution" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <path
        d={path}
        className={`vision-clarity-edge__underlay ${stateClassName}`}
      />
      <path
        id={id}
        d={path}
        markerStart={markerStart}
        markerEnd={markerEnd}
        className={`vision-clarity-edge__path ${stateClassName}`}
      />
      {data?.pulse && (
        <path
          d={path}
          pathLength={100}
          className="vision-clarity-edge__pulse"
        />
      )}
      {data?.label && (
        <EdgeLabelRenderer>
          <span
            className={[
              "vision-clarity-edge__label",
              data.emphasized ? "is-emphasized" : "",
              data.aggregate ? "is-aggregate" : "",
              data.execution ? "is-execution" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            {data.label}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
