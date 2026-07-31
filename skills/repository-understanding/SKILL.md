---
name: repository-understanding
description: Analyze any source repository from deterministic code facts, enrich module purpose without inventing relationships, and return evidence-backed structured results for a code graph or module question.
---

# Repository Understanding

## Purpose

Use this skill when VisionOwl asks for repository module summaries or evidence-backed answers about a selected module.

## Rules

1. Treat parser output, file paths, imports, symbols, and Git metadata as facts.
2. Never create a module or relationship that is absent from the supplied deterministic graph.
3. Read only the minimum source files required to explain a module.
4. Distinguish direct code evidence from inference.
5. Keep module summaries concise and describe responsibility rather than filenames.
6. Do not execute repository programs, installers, tests, or generated scripts during analysis.
7. Do not modify the repository.
8. Cite file paths and line numbers when answering questions.
9. When evidence is insufficient, say what is missing instead of guessing.

## Architecture Boundaries

1. Preserve every detected Git repository boundary before identifying internal
   modules. A module must never contain files from two independent repositories.
2. For a workspace containing several repositories, model each repository or
   independently deployable service as an architecture domain. Discover
   modules only inside that boundary.
3. Do not infer cross-repository imports or calls from name similarity. A
   cross-repository edge requires an HTTP/RPC contract, queue or datastore
   operation, deployment wiring, or a source-backed execution flow.
4. Do not use the workspace folder itself as a synthetic root component.
5. Prefer stable product or service names from repository metadata, manifests,
   entry points, and deployment configuration. Do not replace a known service
   name with a generic phrase such as "engineering metadata".
6. Name an internal module by its responsibility. The summary must mention the
   concrete entry point, boundary, data operation, or runtime role that supports
   the name.

## Infrastructure Evidence

Model a persistence or external dependency only when deterministic evidence
exists in configuration, client initialization, SQL, queue operations, SDK
calls, or a validated execution-flow artifact.

Useful infrastructure entities include:

- databases and important tables;
- Redis caches, indexes, queues, and task-detail records;
- log stores and result sinks;
- message queues and external service endpoints.

Keep infrastructure separate from code modules. Record the source file,
symbol, and operation that proves each connection. A familiar technology name
in prose alone is not sufficient evidence.

Group resources by the actual system boundary: keep Redis keys and queues in
one Redis domain, MySQL tables in a MySQL domain, and SLS Logstores in an SLS
domain. Do not place unrelated datastores into one generic "Infrastructure"
container.

## Relationship Semantics

Classify a relationship by what the code proves:

- `imports`: static source dependency;
- `calls`: runtime function or service call;
- `reads` / `writes`: persistent data access;
- `pushes` / `pops`: queue interaction;
- `dispatches`: task delivery;
- `reports`: result upload or log delivery.

Do not present a static import as if it were a runtime request. When only the
static relationship is known, keep it static and say that runtime behavior is
not proven.

## Module Summary

A useful module summary answers:

- what responsibility the module owns;
- what enters and leaves it;
- what other modules it directly depends on;
- what persistence, network, or external boundary it touches;
- what evidence supports the description.

Do not repeat the module name as its summary.
Do not use a directory name, file count, language, or generic metadata as the
user-facing responsibility sentence.

## Structured Enrichment

When a schema is supplied, return only fields allowed by that schema.

Preserve every supplied module ID exactly.

Tags should be short, factual, and useful for filtering. Avoid generic tags such as code, module, system, or important.
