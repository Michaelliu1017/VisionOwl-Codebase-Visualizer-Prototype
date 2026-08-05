import assert from 'node:assert/strict'
import test from 'node:test'

import { analyzeChangeImpact } from '../src/index.js'

test('finds directly changed nodes and their one-hop neighbors', () => {
  const impact = analyzeChangeImpact(
    {
      nodes: [
        { id: 'api', path: 'services/api', metadata: { files: ['services/api/index.js'] } },
        { id: 'worker', path: 'services/worker' },
        { id: 'database', path: 'infra/database' }
      ],
      edges: [
        { source: 'api', target: 'worker' },
        { source: 'worker', target: 'database' }
      ]
    },
    ['./services/api/index.js']
  )

  assert.deepEqual(impact.changedPaths, ['services/api/index.js'])
  assert.deepEqual(impact.directNodeIds, ['api'])
  assert.deepEqual(impact.affectedNodeIds, ['api', 'worker'])
})

test('accepts entity and relation field names used by scanner graphs', () => {
  const impact = analyzeChangeImpact(
    {
      entities: [{ id: 'docs', evidence: [{ file: 'modules/docs/index.js' }] }],
      relations: []
    },
    ['modules/docs/index.js']
  )

  assert.deepEqual(impact.directNodeIds, ['docs'])
  assert.deepEqual(impact.affectedNodeIds, ['docs'])
})
