import { summarizeGraph } from './graph-summary.js'

/**
 * Convert a graph snapshot into a stable summary for dashboards and reports.
 * Keeping this entry point small gives callers one public module boundary.
 */
export function collectRepositoryInsights(graph) {
  return {
    generatedAt: new Date().toISOString(),
    ...summarizeGraph(graph)
  }
}
