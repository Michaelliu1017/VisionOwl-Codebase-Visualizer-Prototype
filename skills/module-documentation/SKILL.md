---
name: module-documentation
description: Generate or update evidence-backed code module documentation from a selected architecture graph node and its source relationships. Use for concise module responsibility, boundaries, entry points, dependencies, flows, operations, and source evidence without inventing behavior.
---

# Module Documentation

## Workflow

1. Treat graph context as navigation, not proof. Verify important claims in source files.
2. Read only the selected module, its direct entry points, and immediate dependency boundaries.
3. Separate code facts from inference. Omit uncertain claims instead of filling gaps.
4. Preserve useful human-authored material when updating an existing document.
5. Return complete Markdown suitable for an engineering document.

## Required document shape

- `# <module name>`
- `## Purpose`
- `## Responsibilities`
- `## Entry points`
- `## Dependencies and interactions`
- `## Main flow`
- `## Configuration and data`
- `## Failure and operational notes`
- `## Source evidence`

Keep sections concise. Omit a section when the repository contains no evidence for it. Source evidence must use repository-relative paths and line numbers where available.

## Update rules

- Make the smallest change that restores accuracy.
- Do not rewrite unaffected prose for style alone.
- For commit-driven updates, return `no_change` when the commit does not alter any documented behavior, contract, dependency, configuration, or operational fact.
- For a manual module refresh, compare the complete existing document with the current selected-module source and return `no_change` only when the document is already accurate and sufficiently complete.
- Never mention the analysis agent, prompt, or Skill in the generated document.
