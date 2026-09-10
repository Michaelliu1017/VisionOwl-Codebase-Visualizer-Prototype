create schema if not exists knowledge_generator;

create table if not exists knowledge_generator.repository_sources (
  id text primary key,
  project_id text not null,
  repository_id text,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists knowledge_generator.sync_runs (
  id text primary key,
  source_id text not null references knowledge_generator.repository_sources(id) on delete cascade,
  status text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists knowledge_generator.sync_checkpoints (
  source_id text not null references knowledge_generator.repository_sources(id) on delete cascade,
  resource_type text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (source_id, resource_type)
);

create table if not exists knowledge_generator.raw_records (
  id text primary key,
  repository_id text not null,
  resource_type text not null,
  external_id text not null,
  checksum text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists kg_raw_records_repository_idx
  on knowledge_generator.raw_records(repository_id, resource_type);

create table if not exists knowledge_generator.evidence_nodes (
  id text primary key,
  repository_id text not null,
  kind text not null,
  external_id text not null,
  checksum text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (repository_id, kind, external_id)
);

create index if not exists kg_evidence_nodes_repository_idx
  on knowledge_generator.evidence_nodes(repository_id, kind);

create table if not exists knowledge_generator.evidence_edges (
  id text primary key,
  repository_id text not null,
  from_id text not null references knowledge_generator.evidence_nodes(id) on delete cascade,
  to_id text not null references knowledge_generator.evidence_nodes(id) on delete cascade,
  relation_type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (from_id, relation_type, to_id)
);

create index if not exists kg_evidence_edges_repository_idx
  on knowledge_generator.evidence_edges(repository_id, relation_type);

create table if not exists knowledge_generator.pending_links (
  id text primary key,
  repository_id text not null,
  from_id text not null,
  expected_to_id text not null,
  relation_type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists kg_pending_links_repository_idx
  on knowledge_generator.pending_links(repository_id, relation_type);
