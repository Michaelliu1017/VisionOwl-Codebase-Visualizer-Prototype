-- VisionOwl Core 与 Knowledge Generator / Skill Lab 的集成数据模型。
-- 资产版本只追加；扩展模块只提交候选产物，current_version_id 只能由 Core 切换。

CREATE TABLE IF NOT EXISTS knowledge_assets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('wiki', 'skills')),
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'generating', 'ready', 'updating', 'failed', 'stale')),
  current_version_id  uuid,
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_assets_project
  ON knowledge_assets(project_id, kind);

CREATE TABLE IF NOT EXISTS knowledge_generation_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  graph_version_id      uuid NOT NULL REFERENCES graph_versions(id) ON DELETE RESTRICT,
  requested_assets      text[] NOT NULL,
  status                text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'running', 'publishing', 'succeeded', 'failed', 'canceled')),
  progress              smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  stage                 text,
  note                  text,
  command_id            uuid NOT NULL UNIQUE,
  idempotency_key       text NOT NULL UNIQUE,
  output_version_ids    jsonb NOT NULL DEFAULT '[]'::jsonb,
  error                 text,
  created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  dispatched_at         timestamptz,
  started_at            timestamptz,
  finished_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_knowledge_runs_project_created
  ON knowledge_generation_runs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_runs_dispatch
  ON knowledge_generation_runs(status, dispatched_at);

CREATE TABLE IF NOT EXISTS knowledge_asset_versions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id                  uuid NOT NULL REFERENCES knowledge_assets(id) ON DELETE CASCADE,
  project_id                uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_no                int NOT NULL,
  status                    text NOT NULL
                            CHECK (status IN ('candidate', 'published', 'rejected', 'superseded')),
  source_graph_version_id   uuid NOT NULL REFERENCES graph_versions(id) ON DELETE RESTRICT,
  source_generation_run_id  uuid REFERENCES knowledge_generation_runs(id) ON DELETE SET NULL,
  repository_commits        jsonb NOT NULL DEFAULT '{}'::jsonb,
  bundle_artifact_key       text NOT NULL,
  manifest_artifact_key     text NOT NULL,
  checksum                  text NOT NULL,
  summary                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, version_no)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_versions_project_created
  ON knowledge_asset_versions(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_versions_source_graph
  ON knowledge_asset_versions(source_graph_version_id);

ALTER TABLE knowledge_assets
  ADD CONSTRAINT fk_knowledge_assets_current_version
  FOREIGN KEY (current_version_id)
  REFERENCES knowledge_asset_versions(id)
  ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS skill_evaluation_runs (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  input_skill_version_id    uuid NOT NULL REFERENCES knowledge_asset_versions(id) ON DELETE RESTRICT,
  baseline_version_id       uuid REFERENCES knowledge_asset_versions(id) ON DELETE SET NULL,
  output_skill_version_id   uuid REFERENCES knowledge_asset_versions(id) ON DELETE SET NULL,
  status                    text NOT NULL DEFAULT 'queued'
                            CHECK (status IN ('queued', 'evaluating', 'optimizing', 'validating', 'succeeded', 'rejected', 'failed')),
  progress                  smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  stage                     text,
  note                      text,
  command_id                uuid NOT NULL UNIQUE,
  idempotency_key           text NOT NULL UNIQUE,
  evaluation_dataset_ref    text NOT NULL,
  optimization_policy       jsonb NOT NULL DEFAULT '{}'::jsonb,
  scores                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  report_artifact_key       text,
  diff_artifact_key         text,
  decision                  text CHECK (decision IS NULL OR decision IN ('accepted', 'rejected')),
  error                     text,
  dispatched_at             timestamptz,
  started_at                timestamptz,
  finished_at               timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_skill_runs_project_created
  ON skill_evaluation_runs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_runs_dispatch
  ON skill_evaluation_runs(status, dispatched_at);

INSERT INTO knowledge_assets (project_id, kind)
SELECT p.id, kind
  FROM projects p
 CROSS JOIN (VALUES ('wiki'), ('skills')) AS kinds(kind)
ON CONFLICT (project_id, kind) DO NOTHING;
