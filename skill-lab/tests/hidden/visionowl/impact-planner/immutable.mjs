import assert from 'node:assert/strict'
import { planImpact } from '../../modules/impact-planner/src/index.js'

const graph = {
  nodes: [{ id: 'api' }, { id: 'worker' }],
  edges: [{ source: 'api', target: 'worker' }]
}
const changed = ['api']
const beforeGraph = JSON.stringify(graph)
const beforeChanged = JSON.stringify(changed)
Object.freeze(graph.nodes[0])
Object.freeze(graph.nodes[1])
Object.freeze(graph.edges[0])
Object.freeze(graph.nodes)
Object.freeze(graph.edges)
Object.freeze(graph)
Object.freeze(changed)

planImpact(graph, changed)
assert.equal(JSON.stringify(graph), beforeGraph)
assert.equal(JSON.stringify(changed), beforeChanged)
