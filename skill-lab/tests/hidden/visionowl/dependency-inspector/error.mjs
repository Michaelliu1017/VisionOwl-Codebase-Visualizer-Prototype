import assert from 'node:assert/strict'
import { inspectDependencies } from '../../modules/dependency-inspector/src/index.js'

assert.throws(
  () => inspectDependencies({
    nodes: [{ id: 'known' }],
    edges: [{ source: 'known', target: 'missing' }]
  }),
  error => Boolean(
    error &&
    typeof error.code === 'string' &&
    error.code.length > 0 &&
    error.details &&
    typeof error.details === 'object'
  )
)
