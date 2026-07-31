import {
  EdgeLabelRenderer,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import type {
  EdgeFlow,
  EdgePoint,
  EventSeverity,
  FlowDirection,
} from "../types";

export type ActivityEdgeData = {
  label: string;
  active: boolean;
  direction: FlowDirection;
  severity: EventSeverity;
  flow: EdgeFlow;
  selected: boolean;
  dimmed: boolean;
  routePoints?: EdgePoint[];
  labelPosition?: EdgePoint;
};

export type ActivityFlowEdge = Edge<ActivityEdgeData, "activity">;

function getPolylineMidpoint(points: EdgePoint[]) {
  const segments = points.slice(1).map((point, index) => {
    const previous = points[index];
    return {
      from: previous,
      to: point,
      length:
        Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y),
    };
  });
  const halfLength =
    segments.reduce((total, segment) => total + segment.length, 0) / 2;
  let travelled = 0;

  for (const segment of segments) {
    if (travelled + segment.length >= halfLength) {
      const remaining = halfLength - travelled;
      const ratio = segment.length === 0 ? 0 : remaining / segment.length;
      return {
        x: segment.from.x + (segment.to.x - segment.from.x) * ratio,
        y: segment.from.y + (segment.to.y - segment.from.y) * ratio,
      };
    }
    travelled += segment.length;
  }

  return points[Math.floor(points.length / 2)];
}

export function ActivityEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<ActivityFlowEdge>) {
  const defaultPath = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 18,
    offset: 24,
  });

  const edgeData = data ?? {
    label: "",
    active: false,
    direction: "forward",
    severity: "info",
    flow: "control",
    selected: false,
    dimmed: false,
  };
  const routedPoints = edgeData.routePoints?.length
    ? [
        { x: sourceX, y: sourceY },
        ...edgeData.routePoints,
        { x: targetX, y: targetY },
      ]
    : null;
  const routedMidpoint = routedPoints
    ? getPolylineMidpoint(routedPoints)
    : null;
  const path = routedPoints
    ? routedPoints
        .map((point, index) =>
          index === 0 ? `M ${point.x} ${point.y}` : `L ${point.x} ${point.y}`,
        )
        .join(" ")
    : defaultPath[0];
  const labelX =
    edgeData.labelPosition?.x ?? routedMidpoint?.x ?? defaultPath[1];
  const labelY =
    edgeData.labelPosition?.y ?? routedMidpoint?.y ?? defaultPath[2];
  const shouldAnimate =
    edgeData.active ||
    edgeData.severity === "warning" ||
    edgeData.severity === "error";

  return (
    <>
      <path
        id={id}
        d={path}
        className={[
          "activity-edge__base",
          `is-${edgeData.flow}`,
          `is-severity-${edgeData.severity}`,
          edgeData.selected ? "is-selected" : "",
          edgeData.dimmed ? "is-dimmed" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        pathLength={100}
      />

      {shouldAnimate && (
        <>
          <path
            d={path}
            className={[
              "activity-edge__glow",
              `is-${edgeData.severity}`,
              `is-${edgeData.flow}`,
            ].join(" ")}
            pathLength={100}
          />
          <path
            d={path}
            className={[
              "activity-edge__pulse",
              `is-${edgeData.severity}`,
              `is-${edgeData.flow}`,
              edgeData.direction === "reverse" ? "is-reverse" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            pathLength={100}
          />
        </>
      )}

      <EdgeLabelRenderer>
        <div
          className={[
            "activity-edge__label",
            `is-${edgeData.flow}`,
            `is-severity-${edgeData.severity}`,
            edgeData.active ? "is-active" : "",
            edgeData.selected ? "is-selected" : "",
            edgeData.dimmed ? "is-dimmed" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
        >
          {edgeData.label}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
