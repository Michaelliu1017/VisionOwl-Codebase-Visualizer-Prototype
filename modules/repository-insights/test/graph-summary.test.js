import assert from 'node:assert/strict'
import test from 'node:test'

import { collectRepositoryInsights } from '../src/index.js'

test('summarizes graph nodes and edges by type', () => {
  const summary = collectRepositoryInsights({
    nodes: [{ kind: 'service' }, { kind: 'service' }, { kind: 'database' }],
    edges: [{ type: 'calls' }, { type: 'reads' }]
  })

  assert.equal(summary.nodeCount, 3)
  assert.equal(summary.edgeCount, 2)
  assert.deepEqual(summary.nodesByKind, { service: 2, database: 1 })
  assert.deepEqual(summary.edgesByType, { calls: 1, reads: 1 })
  assert.match(summary.generatedAt, /^\d{4}-\d{2}-\d{2}T/)
})
