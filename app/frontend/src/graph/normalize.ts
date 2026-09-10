import type { EdgeType, GraphArtifact, NodeKind } from '../api/types'

const NODE_KINDS = new Set<NodeKind>([
  'domain', 'module', 'submodule', 'class', 'function', 'interface', 'config',
  'infra.redis', 'infra.mq', 'infra.db', 'external'
])
const EDGE_TYPES = new Set<EdgeType>([
  'call', 'dependency', 'read', 'write', 'publish', 'consume', 'implement', 'contains'
])

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback
}

/** Keep older graph versions renderable even when historic semantic patches contain nullable fields. */
export function normalizeGraphArtifact(input: GraphArtifact): GraphArtifact {
  const rawNodes = Array.isArray(input.nodes) ? input.nodes : []
  const nodes = rawNodes
    .filter(node => typeof node?.id === 'string' && node.id.length > 0)
    .map(node => {
      const kind = NODE_KINDS.has(node.kind) ? node.kind : 'module'
      return {
        ...node,
        name: nonEmptyString(node.name, node.id),
        kind,
        path: typeof node.path === 'string' ? node.path : null,
        domain: nonEmptyString(node.domain, 'other'),
        summary: nonEmptyString(node.summary, '暂无模块说明'),
        evidence: Array.isArray(node.evidence) ? node.evidence : [],
        inferred: node.inferred === true,
        docRefs: Array.isArray(node.docRefs) ? node.docRefs : []
      }
    })

  const nodeIds = new Set(nodes.map(node => node.id))
  const rawEdges = Array.isArray(input.edges) ? input.edges : []
  const edges = rawEdges
    .filter(edge =>
      typeof edge?.id === 'string' && edge.id.length > 0 &&
      typeof edge.source === 'string' && nodeIds.has(edge.source) &&
      typeof edge.target === 'string' && nodeIds.has(edge.target)
    )
    .map(edge => ({
      ...edge,
      type: EDGE_TYPES.has(edge.type) ? edge.type : 'dependency' as EdgeType,
      evidence: Array.isArray(edge.evidence) ? edge.evidence : [],
      inferred: edge.inferred === true
    }))

  const edgeIds = new Set(edges.map(edge => edge.id))
  const views = (Array.isArray(input.views) ? input.views : []).map((view, index) => ({
    ...view,
    id: nonEmptyString(view.id, `view:${index}`),
    name: nonEmptyString(view.name, `视图 ${index + 1}`),
    nodeIds: (Array.isArray(view.nodeIds) ? view.nodeIds : []).filter(id => nodeIds.has(id)),
    edgeIds: (Array.isArray(view.edgeIds) ? view.edgeIds : []).filter(id => edgeIds.has(id)),
    steps: Array.isArray(view.steps)
      ? view.steps.filter(step => step && edgeIds.has(step.edgeId))
      : undefined
  }))

  return {
    ...input,
    nodes,
    edges,
    views,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      inferredCount: nodes.filter(node => node.inferred).length + edges.filter(edge => edge.inferred).length
    }
  }
}
