-- Project 多仓库绑定、父任务仓库快照与仓库扫描子任务。

ALTER TABLE repository_bindings
  DROP CONSTRAINT IF EXISTS repository_bindings_project_id_key;

ALTER TABLE repository_bindings
  ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false;

UPDATE repository_bindings b
   SET is_primary = true
 WHERE b.id IN (
   SELECT DISTINCT ON (project_id) id
     FROM repository_bindings
    ORDER BY project_id, created_at, id
 );

CREATE UNIQUE INDEX IF NOT EXISTS idx_bindings_project_repo_branch
  ON repository_bindings(project_id, repo_full_name, branch);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bindings_one_primary
  ON repository_bindings(project_id)
  WHERE is_primary;

ALTER TABLE analysis_jobs
  ADD COLUMN IF NOT EXISTS repository_commits jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE graph_versions
  ADD COLUMN IF NOT EXISTS repository_commits jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS analysis_job_repositories (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                     uuid NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
  project_id                 uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  binding_id                 uuid REFERENCES repository_bindings(id) ON DELETE SET NULL,
  repo_full_name             text NOT NULL,
  repository_id              text NOT NULL,
  installation_id            bigint,
  branch                     text NOT NULL,
  base_commit_sha            text,
  commit_sha                 text NOT NULL,
  status                     text NOT NULL DEFAULT 'queued',
  progress                   smallint NOT NULL DEFAULT 0,
  attempts                   smallint NOT NULL DEFAULT 0,
  graph_oss_key              text,
  interface_catalog_oss_key  text,
  impact_oss_key             text,
  credits                    numeric(10,3),
  error                      text,
  started_at                 timestamptz,
  finished_at                timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id, repo_full_name, branch)
);

CREATE INDEX IF NOT EXISTS idx_job_repositories_job
  ON analysis_job_repositories(job_id, status);

CREATE INDEX IF NOT EXISTS idx_job_repositories_status
  ON analysis_job_repositories(status, updated_at);
