---
name: visionowl-quality-review
description: Review VisionOwl graph quality reports, module reports, patches, and unresolved diagnostics without modifying the graph. Use after deterministic validation to explain failures and define the smallest retry scope.
---

# VisionOwl Quality Review

## Review

Read `quality-report.json`, accepted/rejected patches, diagnostics, module reports, and graph fingerprints.

1. Confirm module and critical-entry coverage.
2. Check evidence localization, ungrounded conclusions, relation direction, flow continuity, and rerun stability.
3. Classify findings as `hard_fail`, `retry`, or `warning` using the deterministic report as the authority.
4. For retry findings, identify the smallest repository/module/fact/entry scope and the missing evidence.
5. Explain conflicts and likely parser gaps without changing graph artifacts.

Never lower thresholds, fabricate evidence, accept a stale commit, or rewrite `graph.json`. Output a review report and retry recommendations only.
