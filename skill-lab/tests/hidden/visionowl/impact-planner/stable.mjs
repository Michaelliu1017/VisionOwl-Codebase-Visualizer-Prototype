import assert from 'node:assert/strict'
import { planImpact } from '../../modules/impact-planner/src/index.js'

const first = planImpact({
  nodes: [{ id: 'queue' }, { id: 'api' }, { id: 'worker' }],
  edges: [
    { source: 'worker', target: 'queue' },
    { source: 'api', target: 'worker' },
    { source: 'queue', target: 'api' }
  ]
}, ['api'])
const second = planImpact({
  nodes: [{ id: 'worker' }, { id: 'queue' }, { id: 'api' }],
  edges: [
    { source: 'queue', target: 'api' },
    { source: 'api', target: 'worker' },
    { source: 'worker', target: 'queue' }
  ]
}, ['api'])

assert.deepEqual(first, second)
assert.deepEqual(first.directNodeIds, ['api'])
assert.deepEqual(first.affectedNodeIds, ['api', 'queue', 'worker'])
