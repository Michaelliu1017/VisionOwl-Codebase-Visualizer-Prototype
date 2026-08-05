function asList(value) {
  return Array.isArray(value) ? value : []
}

/** Summarize node kinds and relationship types without retaining source content. */
export function summarizeGraph(graph = {}) {
  const nodes = asList(graph.nodes)
  const edges = asList(graph.edges)

  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodesByKind: countBy(nodes, node => node.kind ?? 'unknown'),
    edgesByType: countBy(edges, edge => edge.type ?? 'unknown')
  }
}

function countBy(items, selectKey) {
  return items.reduce((counts, item) => {
    const key = selectKey(item)
    counts[key] = (counts[key] ?? 0) + 1
    return counts
  }, {})
}
