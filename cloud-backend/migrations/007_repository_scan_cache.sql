-- Reuse unchanged repository scan artifacts across incremental multi-repository jobs.

ALTER TABLE analysis_job_repositories
  ADD COLUMN IF NOT EXISTS pipeline_version text NOT NULL DEFAULT 'legacy';

CREATE INDEX IF NOT EXISTS idx_job_repositories_artifact_cache
  ON analysis_job_repositories(project_id, repository_id, commit_sha, pipeline_version, finished_at DESC)
  WHERE status = 'succeeded'
    AND graph_oss_key IS NOT NULL
    AND interface_catalog_oss_key IS NOT NULL;
