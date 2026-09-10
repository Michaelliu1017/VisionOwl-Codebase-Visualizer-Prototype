import type { GraphArtifact } from '../api/types'

export interface Adjacency {
  nodeIds: Set<string>
  edgeIds: Set<string>
}

/**
 * 邻接索引:图谱数据变化时构建一次。
 * 交互契约:邻接高亮是 selectedNodeId 的投影,由此索引派生,边不自持高亮。
 */
export function buildAdjacency(graph: GraphArtifact): Map<string, Adjacency> {
  const map = new Map<string, Adjacency>()
  for (const n of graph.nodes) {
    map.set(n.id, { nodeIds: new Set(), edgeIds: new Set() })
  }
  for (const e of graph.edges) {
    const s = map.get(e.source)
    const t = map.get(e.target)
    if (!s || !t) continue // 悬空边:轻校验阶段已告警,这里防御性跳过
    s.nodeIds.add(e.target)
    s.edgeIds.add(e.id)
    t.nodeIds.add(e.source)
    t.edgeIds.add(e.id)
  }
  return map
}

/** 轻量 Schema 校验(渲染前守门,契约 §7):返回问题列表,空数组 = 通过 */
export function validateGraph(graph: GraphArtifact): string[] {
  const problems: string[] = []
  const ids = new Set<string>()
  for (const n of graph.nodes) {
    if (ids.has(n.id)) problems.push(`节点 id 重复: ${n.id}`)
    ids.add(n.id)
    if (!n.inferred && n.evidence.length === 0) {
      problems.push(`非推断节点缺少证据: ${n.id}`)
    }
  }
  for (const e of graph.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) {
      problems.push(`悬空边: ${e.id}`)
    }
  }
  return problems
}
