import assert from 'node:assert/strict'
import { inspectDependencies } from '../../modules/dependency-inspector/src/index.js'

const first = inspectDependencies({
  nodes: [{ id: 'c' }, { id: 'a' }, { id: 'b' }],
  edges: [
    { source: 'b', target: 'c' },
    { source: 'c', target: 'a' },
    { source: 'a', target: 'b' }
  ]
})
const second = inspectDependencies({
  nodes: [{ id: 'b' }, { id: 'c' }, { id: 'a' }],
  edges: [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
    { source: 'c', target: 'a' }
  ]
})

assert.deepEqual(first, second)
assert.deepEqual(first.nodeIds, ['a', 'b', 'c'])
assert.ok(Array.isArray(first.cycles))
