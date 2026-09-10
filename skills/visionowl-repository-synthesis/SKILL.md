---
name: visionowl-repository-synthesis
description: Synthesize validated VisionOwl module reports and accepted graph patches into repository-level architecture, flows, risks, and views. Use after all required module jobs reach a terminal state; avoid rereading the whole repository.
---

# VisionOwl Repository Synthesis

## Inputs

Read Fact Index summaries, module reports, accepted/rejected patches, deterministic module edges, interface/resource catalogs, and diagnostics. Source access is denied by default.

## Workflow

1. Build the repository responsibility hierarchy from validated module reports.
2. Connect only flows whose steps have continuous source, edge, target, and evidence.
3. Reconcile duplicate or conflicting module claims without using last-writer-wins.
4. Produce repository-level architecture, data flows, risks, unresolved gaps, and `add_view`/`update_summary` Patch proposals.
5. When evidence is insufficient, emit a targeted read request instead of guessing.

## Guardrails

- Do not alter deterministic nodes or edges directly.
- Do not turn diagnostics into facts.
- Preserve repository ID, commit SHA, Fact IDs, operation generators, and skill version.
- Separate verified, configured, inferred, and unresolved conclusions in every report.
