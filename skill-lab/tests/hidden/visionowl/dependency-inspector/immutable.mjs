import assert from 'node:assert/strict'
import { inspectDependencies } from '../../modules/dependency-inspector/src/index.js'

const graph = {
  nodes: [{ id: 'b' }, { id: 'a' }],
  edges: [{ source: 'a', target: 'b' }]
}
const before = JSON.stringify(graph)
Object.freeze(graph.nodes[0])
Object.freeze(graph.nodes[1])
Object.freeze(graph.edges[0])
Object.freeze(graph.nodes)
Object.freeze(graph.edges)
Object.freeze(graph)

inspectDependencies(graph)
assert.equal(JSON.stringify(graph), before)
