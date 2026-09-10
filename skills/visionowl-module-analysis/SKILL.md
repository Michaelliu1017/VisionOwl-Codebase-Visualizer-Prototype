---
name: visionowl-module-analysis
description: Analyze one or more VisionOwl Analysis Packets for module responsibilities, boundaries, local flows, risks, and evidence-backed graph corrections. Use inside Module Runner after Fact Index v2; never rewrite the deterministic base graph.
---

# VisionOwl Module Analysis

## Contract

Read `analysis-packets.json`, `facts.v2.json`, `symbol-index.json`, `graph.base.json`, and only the source files listed in the current packet's `allowedFiles`.

For each packet:

1. Confirm the module boundary, entry facts, public symbols, one-hop neighbors, interfaces, resources, and diagnostics.
2. Answer the packet's standard questions from source evidence.
3. Write a concise module report containing responsibility, non-responsibility, entries, dependencies, local flows, risks, and unresolved questions.
4. Propose corrections only through `graph-patch.json` operations.

## Output Rules

- Never modify `graph.base.json`, `facts.v2.json`, or existing deterministic IDs.
- Every Patch operation must preserve the packet repository and commit, cite real file/line evidence, and use confidence at least `0.65`.
- Use `update_summary` for semantic descriptions. Use `set_architecture` when entrypoints, dependencies, runtime resources, or deployment files prove that a module is primary, supporting, or detail. Use structural operations only when Scanner facts are demonstrably missing or wrong.
- Do not infer a call from similar names, shared regions, shared database tables, or directory proximity.
- If more source is required, record a targeted read request with repository, module, symbol, reason, and requested paths. Do not scan arbitrary files.
- Mark unprovable claims unresolved; do not add them to the Patch.

Finish one packet before moving to the next so failures and retries remain module-scoped.
