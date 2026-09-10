import type { GraphArtifact, GraphNode, GraphView } from '../api/types'

export const MAX_AUTOMATIC_VIEW_NODES = 24

export interface ResolvedGraphView {
  requested: GraphView | undefined
  render: GraphView | undefined
  preferred: GraphView | undefined
  guarded: boolean
  sourceNodeCount: number
}

function preferredStoredView(artifact: GraphArtifact): GraphView | undefined {
  return artifact.views.find(view => view.id === 'project:overview')
    ?? artifact.views.find(view => view.id === 'overview')
    ?? artifact.views[0]
}

export function rankGraphNode(node: GraphNode): number {
  const importance = node.architecture?.importance
  const visible = node.architecture?.visibleByDefault
  if (visible && importance === 'primary') return 0
  if (visible && importance === 'supporting') return 1
  if (visible) return 2
  if (!node.parentId && node.kind === 'module') return 3
  if (!node.parentId && node.kind.startsWith('infra.')) return 4
  return 5
}

function safeOverviewView(artifact: GraphArtifact): GraphView | undefined {
  const storedOverview = artifact.views.find(view => view.id === 'project:overview')
    ?? artifact.views.find(view => view.id === 'overview')
  if (storedOverview && storedOverview.nodeIds.length <= MAX_AUTOMATIC_VIEW_NODES) {
    return storedOverview
  }

  const preferredNodeIds = artifact.nodes
    .filter(node => node.architecture?.visibleByDefault || (
      !node.parentId && (node.kind === 'module' || node.kind.startsWith('infra.'))
    ))
    .sort((left, right) => rankGraphNode(left) - rankGraphNode(right) || left.id.localeCompare(right.id))
    .slice(0, MAX_AUTOMATIC_VIEW_NODES)
    .map(node => node.id)
  const nodeIds = preferredNodeIds.length > 0
    ? preferredNodeIds
    : artifact.nodes.slice(0, MAX_AUTOMATIC_VIEW_NODES).map(node => node.id)
  if (nodeIds.length === 0) return storedOverview ?? artifact.views[0]

  const nodeSet = new Set(nodeIds)
  return {
    id: '__safe-overview',
    name: storedOverview?.name ?? '总体架构',
    nodeIds,
    edgeIds: artifact.edges
      .filter(edge => nodeSet.has(edge.source) && nodeSet.has(edge.target))
      .map(edge => edge.id)
  }
}

/** Resolve the view before React paints so a stale view id cannot expose ELK to a huge fallback view. */
export function resolveGraphView(artifact: GraphArtifact | null, activeViewId: string): ResolvedGraphView {
  if (!artifact || artifact.views.length === 0) {
    return { requested: undefined, render: undefined, preferred: undefined, guarded: false, sourceNodeCount: 0 }
  }
  const preferred = preferredStoredView(artifact)
  const requested = artifact.views.find(view => view.id === activeViewId)
  const candidate = requested ?? preferred
  const guarded = Boolean(candidate && candidate.nodeIds.length > MAX_AUTOMATIC_VIEW_NODES)
  return {
    requested,
    render: guarded || !requested ? safeOverviewView(artifact) ?? candidate : candidate,
    preferred,
    guarded,
    sourceNodeCount: candidate?.nodeIds.length ?? 0
  }
}
