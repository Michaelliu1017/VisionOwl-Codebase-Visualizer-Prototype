import ELK from 'elkjs/lib/elk.bundled.js'
import type { GraphEdge, GraphNode } from '../api/types'

export const NODE_W = 176
export const NODE_H = 56
export const SUBMODULE_W = 158
export const SUBMODULE_H = 52
export const INFRA_W = 104
export const INFRA_H = 78

const elk = new ELK()

const DOMAIN_FRAME_X = 42
const DOMAIN_FRAME_TOP = 58
const DOMAIN_FRAME_BOTTOM = 38

const DOMAIN_ORDER = ['client', 'local-runtime', 'cloud-runtime', 'shared', 'external', 'apps', 'modules', 'packages', 'infra']

function domainOf(node: GraphNode): string {
  if (node.architecture?.displayGroup) return node.architecture.displayGroup
  return typeof node.domain === 'string' && node.domain.trim() ? node.domain : 'other'
}

export interface LayoutedPosition {
  x: number
  y: number
}

export function sizeOf(node: GraphNode): { width: number; height: number } {
  if (typeof node.kind === 'string' && node.kind.startsWith('infra.')) return { width: INFRA_W, height: INFRA_H }
  if (node.kind === 'submodule') return { width: SUBMODULE_W, height: SUBMODULE_H }
  return { width: NODE_W, height: NODE_H }
}

interface DomainLayout {
  domain: string
  width: number
  height: number
  positions: Map<string, LayoutedPosition>
}

function orderedDomainLayouts(
  layouts: DomainLayout[],
  crossDomainEdges: Array<{ source: string; target: string }>,
): DomainLayout[] {
  const fallbackOrder = new Map(layouts.map((layout, index) => [layout.domain, index]));
  const byDomain = new Map(layouts.map((layout) => [layout.domain, layout]));
  const indegree = new Map(layouts.map((layout) => [layout.domain, 0]));
  const targets = new Map(layouts.map((layout) => [layout.domain, new Set<string>()]));
  for (const edge of crossDomainEdges) {
    if (!byDomain.has(edge.source) || !byDomain.has(edge.target) || edge.source === edge.target) continue
    const outgoing = targets.get(edge.source)!
    if (outgoing.has(edge.target)) continue
    outgoing.add(edge.target)
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
  }
  const queue = layouts
    .filter((layout) => indegree.get(layout.domain) === 0)
    .sort((left, right) => (fallbackOrder.get(left.domain) ?? 0) - (fallbackOrder.get(right.domain) ?? 0))
  const ordered: DomainLayout[] = []
  while (queue.length > 0) {
    const current = queue.shift()!
    ordered.push(current)
    for (const target of targets.get(current.domain) ?? []) {
      indegree.set(target, (indegree.get(target) ?? 1) - 1)
      if (indegree.get(target) === 0) {
        queue.push(byDomain.get(target)!)
        queue.sort((left, right) => (fallbackOrder.get(left.domain) ?? 0) - (fallbackOrder.get(right.domain) ?? 0))
      }
    }
  }
  for (const layout of layouts) {
    if (!ordered.includes(layout)) ordered.push(layout)
  }
  return ordered
}

export function balancedRowSizes(count: number): number[] {
  if (count <= 0) return []
  if (count <= 2) return [count]
  const columns = Math.max(2, Math.ceil(Math.sqrt(count * 1.45)))
  const sizes: number[] = []
  let remaining = count
  while (remaining > 0) {
    const rowsLeft = Math.ceil(remaining / columns)
    const size = Math.min(columns, Math.ceil(remaining / rowsLeft))
    sizes.push(size)
    remaining -= size
  }
  return sizes
}

function orderedDomains(nodes: GraphNode[]): string[] {
  const domains = [...new Set(nodes.map(domainOf))]
  return domains.sort((a, b) => {
    const ai = DOMAIN_ORDER.indexOf(a)
    const bi = DOMAIN_ORDER.indexOf(b)
    if (ai === -1 && bi === -1) return a.localeCompare(b)
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })
}

async function layoutDomain(
  domain: string,
  nodes: GraphNode[],
  edges: GraphEdge[]
): Promise<DomainLayout> {
  const nodeIds = new Set(nodes.map(node => node.id))
  const result = await elk.layout({
    id: `domain:${domain}`,
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '50',
      'elk.spacing.componentComponent': '64',
      'elk.layered.spacing.nodeNodeBetweenLayers': '80',
      'elk.layered.spacing.edgeNodeBetweenLayers': '29',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '16',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.separateConnectedComponents': 'true'
    },
    children: nodes.map(node => ({ id: node.id, ...sizeOf(node) })),
    edges: edges
      .filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target))
      .map(edge => ({ id: edge.id, sources: [edge.source], targets: [edge.target] }))
  })

  const children = result.children ?? []
  const orderedChildren = [...children].sort((left, right) =>
    (left.y ?? 0) - (right.y ?? 0) || (left.x ?? 0) - (right.x ?? 0) || left.id.localeCompare(right.id),
  )
  const childById = new Map(orderedChildren.map((child) => [child.id, child]))
  const rows: string[][] = []
  let cursor = 0
  for (const size of balancedRowSizes(orderedChildren.length)) {
    rows.push(orderedChildren.slice(cursor, cursor + size).map((child) => child.id))
    cursor += size
  }
  const nodeHorizontalGap = 48
  const nodeVerticalGap = 72
  const rowWidths = rows.map((row) => row.reduce((width, id) =>
    width + (childById.get(id)?.width ?? NODE_W),
  Math.max(0, row.length - 1) * nodeHorizontalGap))
  const maxRowWidth = Math.max(...rowWidths, NODE_W)
  const positions = new Map<string, LayoutedPosition>()
  let y = 0
  rows.forEach((row, rowIndex) => {
    const rowWidth = rowWidths[rowIndex] ?? 0
    let x = (maxRowWidth - rowWidth) / 2
    let rowHeight = 0
    for (const id of row) {
      const child = childById.get(id)
      const width = child?.width ?? NODE_W
      const height = child?.height ?? NODE_H
      positions.set(id, { x, y })
      x += width + nodeHorizontalGap
      rowHeight = Math.max(rowHeight, height)
    }
    y += rowHeight + nodeVerticalGap
  })

  return {
    domain,
    width: maxRowWidth,
    height: Math.max(NODE_H, y - nodeVerticalGap),
    positions
  }
}

/**
 * Domain 内部仍由 ELK 按依赖分层；外层按依赖顺序装入紧凑的横向梯形网格。
 * 这避免线性依赖把总览拉成一条细长竖线，同时让每层保持可读间距。
 */
export async function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[]
): Promise<Map<string, LayoutedPosition>> {
  if (nodes.length === 0) return new Map()

  const domains = orderedDomains(nodes)
  const nodeDomain = new Map(nodes.map(node => [node.id, domainOf(node)]))
  const domainLayouts: DomainLayout[] = []

  for (const domain of domains) {
    domainLayouts.push(await layoutDomain(
      domain,
      nodes.filter(node => domainOf(node) === domain),
      edges
    ))
  }

  const crossDomainEdges = new Map<string, { source: string; target: string }>()
  for (const edge of edges) {
    const source = nodeDomain.get(edge.source)
    const target = nodeDomain.get(edge.target)
    if (!source || !target || source === target) continue
    crossDomainEdges.set(`${source}->${target}`, { source, target })
  }

  const outerLayouts = orderedDomainLayouts(domainLayouts, [...crossDomainEdges.values()])
  const rows: DomainLayout[][] = []
  let cursor = 0
  for (const size of balancedRowSizes(outerLayouts.length)) {
    rows.push(outerLayouts.slice(cursor, cursor + size))
    cursor += size
  }
  const horizontalGap = 112
  const verticalGap = 124
  const rowWidths = rows.map((row) => row.reduce(
    (width, domain) => width + domain.width + DOMAIN_FRAME_X * 2,
    Math.max(0, row.length - 1) * horizontalGap,
  ))
  const maxRowWidth = Math.max(...rowWidths, NODE_W)
  const domainPositions = new Map<string, LayoutedPosition>()
  let y = 0
  rows.forEach((row, rowIndex) => {
    const rowWidth = rowWidths[rowIndex] ?? 0
    let x = (maxRowWidth - rowWidth) / 2
    let rowHeight = 0
    for (const domain of row) {
      domainPositions.set(domain.domain, { x, y })
      const frameWidth = domain.width + DOMAIN_FRAME_X * 2
      const frameHeight = domain.height + DOMAIN_FRAME_TOP + DOMAIN_FRAME_BOTTOM
      x += frameWidth + horizontalGap
      rowHeight = Math.max(rowHeight, frameHeight)
    }
    y += rowHeight + verticalGap
  })
  const positions = new Map<string, LayoutedPosition>()

  for (const domain of domainLayouts) {
    const origin = domainPositions.get(domain.domain) ?? { x: 0, y: 0 }
    for (const [nodeId, local] of domain.positions) {
      positions.set(nodeId, {
        x: origin.x + DOMAIN_FRAME_X + local.x,
        y: origin.y + DOMAIN_FRAME_TOP + local.y
      })
    }
  }

  return positions
}
