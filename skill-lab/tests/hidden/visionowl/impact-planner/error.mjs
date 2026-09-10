import assert from 'node:assert/strict'
import { planImpact } from '../../modules/impact-planner/src/index.js'

assert.throws(
  () => planImpact({ nodes: [{ id: 'api' }], edges: [] }, ['missing']),
  error => Boolean(
    error &&
    typeof error.code === 'string' &&
    error.code.length > 0 &&
    error.details &&
    typeof error.details === 'object'
  )
)
