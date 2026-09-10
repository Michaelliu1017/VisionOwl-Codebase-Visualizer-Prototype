-- 用户显式确认的重新分析任务可以绕过同 commit 缓存，但仍保留原图谱版本。
ALTER TABLE analysis_jobs
  ADD COLUMN IF NOT EXISTS force_reanalysis boolean NOT NULL DEFAULT false;
