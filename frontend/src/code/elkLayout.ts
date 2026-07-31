import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";

export type LayoutNode = {
  id: string;
  width: number;
  height: number;
};

export type LayoutEdge = {
  id: string;
  source: string;
  target: string;
};

export type LayeredLayoutResult = {
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
};

type ElkLayoutEngine = {
  layout(graph: ElkNode): Promise<ElkNode>;
};

let elkEngine: Promise<ElkLayoutEngine> | undefined;

function loadElk() {
  if (!elkEngine) {
    elkEngine = import("elkjs/lib/elk.bundled.js").then(
      ({ default: ELK }) => new ELK(),
    );
  }
  return elkEngine;
}

const BASE_LAYOUT_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.spacing.nodeNode": "100",
  "elk.layered.spacing.nodeNodeBetweenLayers": "140",
  "elk.separateConnectedComponents": "false",
  "elk.padding": "[top=0,left=0,right=0,bottom=0]",
} satisfies Record<string, string>;

function normalizePositions(
  children: ElkNode[],
): LayeredLayoutResult {
  if (children.length === 0) {
    return { positions: new Map(), width: 0, height: 0 };
  }

  const minX = Math.min(...children.map((child) => child.x ?? 0));
  const minY = Math.min(...children.map((child) => child.y ?? 0));
  const positions = new Map<string, { x: number; y: number }>();
  let width = 0;
  let height = 0;

  for (const child of children) {
    const x = (child.x ?? 0) - minX;
    const y = (child.y ?? 0) - minY;
    const childWidth = child.width ?? 0;
    const childHeight = child.height ?? 0;
    positions.set(child.id, { x, y });
    width = Math.max(width, x + childWidth);
    height = Math.max(height, y + childHeight);
  }

  return { positions, width, height };
}

export async function runLayeredLayout({
  id,
  nodes,
  edges,
  direction = "DOWN",
  nodeSpacing = 100,
  layerSpacing = 140,
}: {
  id: string;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  direction?: "DOWN" | "RIGHT";
  nodeSpacing?: number;
  layerSpacing?: number;
}): Promise<LayeredLayoutResult> {
  if (nodes.length === 0) {
    return { positions: new Map(), width: 0, height: 0 };
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const validEdges = edges.filter(
    (edge) =>
      edge.source !== edge.target &&
      nodeIds.has(edge.source) &&
      nodeIds.has(edge.target),
  );
  const input: ElkNode = {
    id,
    layoutOptions: {
      ...BASE_LAYOUT_OPTIONS,
      "elk.direction": direction,
      "elk.spacing.nodeNode": String(nodeSpacing),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(layerSpacing),
    },
    children: nodes.map((node) => ({
      id: node.id,
      width: node.width,
      height: node.height,
    })),
    edges: validEdges.map(
      (edge): ElkExtendedEdge => ({
        id: edge.id,
        sources: [edge.source],
        targets: [edge.target],
      }),
    ),
  };

  const elk = await loadElk();
  const result = await elk.layout(input);
  return normalizePositions(result.children ?? []);
}

export function centeredGridLayout(
  nodes: LayoutNode[],
  {
    columnGap = 120,
    rowGap = 100,
    maxColumns,
  }: {
    columnGap?: number;
    rowGap?: number;
    maxColumns?: number;
  } = {},
): LayeredLayoutResult {
  if (nodes.length === 0) {
    return { positions: new Map(), width: 0, height: 0 };
  }

  const columns = Math.max(
    1,
    Math.min(
      maxColumns ?? Math.ceil(Math.sqrt(nodes.length * 1.6)),
      nodes.length,
    ),
  );
  const rows = Math.ceil(nodes.length / columns);
  const columnWidths = Array.from({ length: columns }, (_, column) =>
    Math.max(
      ...nodes
        .filter((_, index) => index % columns === column)
        .map((node) => node.width),
    ),
  );
  const rowHeights = Array.from({ length: rows }, (_, row) =>
    Math.max(
      ...nodes
        .slice(row * columns, (row + 1) * columns)
        .map((node) => node.height),
    ),
  );
  const contentWidth =
    columnWidths.reduce((sum, width) => sum + width, 0) +
    Math.max(0, columns - 1) * columnGap;
  const rowWidths = Array.from({ length: rows }, (_, row) => {
    const rowNodes = nodes.slice(row * columns, (row + 1) * columns);
    return (
      rowNodes.reduce((sum, node) => sum + node.width, 0) +
      Math.max(0, rowNodes.length - 1) * columnGap
    );
  });
  const positions = new Map<string, { x: number; y: number }>();
  let y = 0;

  for (let row = 0; row < rows; row += 1) {
    const rowNodes = nodes.slice(row * columns, (row + 1) * columns);
    let x = (contentWidth - rowWidths[row]) / 2;
    for (const node of rowNodes) {
      positions.set(node.id, { x, y });
      x += node.width + columnGap;
    }
    y += rowHeights[row] + rowGap;
  }

  return {
    positions,
    width: contentWidth,
    height: y - rowGap,
  };
}
