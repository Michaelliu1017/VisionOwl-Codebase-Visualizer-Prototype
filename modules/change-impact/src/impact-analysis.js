function asList(value) {
  return Array.isArray(value) ? value : []
}

function normalizePath(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '')
}

function nodeFiles(node) {
  const evidenceFiles = asList(node?.evidence).map(item => item?.file)
  const metadataFiles = asList(node?.metadata?.files)
  return [node?.path, ...evidenceFiles, ...metadataFiles]
    .filter(Boolean)
    .map(normalizePath)
}

function matchesChangedPath(node, changedPaths) {
  return nodeFiles(node).some(file =>
    changedPaths.some(changed =>
      file === changed || file.startsWith(`${changed}/`) || changed.startsWith(`${file}/`)
    )
  )
}

/**
 * Identify directly changed graph nodes and expand the result by one relation hop.
 * The output is deterministic so it can be cached by commit and change set.
 */
export function analyzeChangeImpact(graph = {}, changedFiles = []) {
  const nodes = asList(graph.nodes ?? graph.entities)
  const edges = asList(graph.edges ?? graph.relations)
  const changedPaths = [...new Set(asList(changedFiles).map(normalizePath).filter(Boolean))].sort()

  const directNodeIds = nodes
    .filter(node => matchesChangedPath(node, changedPaths))
    .map(node => node.id)
    .filter(Boolean)
    .sort()

  const direct = new Set(directNodeIds)
  const affected = new Set(directNodeIds)
  for (const edge of edges) {
    if (direct.has(edge.source)) affected.add(edge.target)
    if (direct.has(edge.target)) affected.add(edge.source)
  }

  return {
    changedPaths,
    directNodeIds,
    affectedNodeIds: [...affected].filter(Boolean).sort()
  }
}
