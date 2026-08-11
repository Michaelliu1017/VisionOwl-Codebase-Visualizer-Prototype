# Evidence Catalog

`@visionowl/evidence-catalog` creates stable source-evidence records for code
graph nodes, Wiki pages, and Skills. Each record is bound to a repository,
commit, file path, and line number so a conclusion can be traced back to the
exact source revision that supports it.

## API

`createEvidenceRecord(input)` validates and normalizes one source location and
returns a deterministic `id` suitable for graph and knowledge-asset references.
