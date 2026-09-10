---
name: visionowl-cross-repo
description: Explain and validate VisionOwl cross-repository relation candidates from interface catalogs and service identities. Use for Project synthesis across repositories; request directed evidence when matching is not exact.
---

# VisionOwl Cross-Repository Analysis

## Matching Order

Prefer evidence in this order:

1. Package identity: npm, Maven, Go module, or equivalent.
2. OpenAPI method/path/operationId.
3. Protobuf package/service/method or full RPC interface name.
4. Event topic plus event schema.
5. Explicit service-discovery name, URL, or approved alias.

Shared tables, similar names, regions, and adjacent deployment are context only. They do not prove a service call.

## Output

Classify each candidate as `exact`, `configured`, `inferred`, or `unresolved`; include evidence from both repositories and the exact repository commit set. Only exact and sufficiently grounded configured links may enter the default graph. For all other candidates, emit a targeted read request and keep them outside formal edges.
