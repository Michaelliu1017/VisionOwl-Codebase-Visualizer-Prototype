-- ════════════════════════════════════════════════════════════════════
-- VisionOwl 初始化迁移 (spec.md §10)
-- 约定：一律 uuid v4 主键、timestamptz、行级 project_id 隔离
-- ════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS citext;

-- ── 用户 ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext UNIQUE NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  status        text NOT NULL DEFAULT 'active',      -- active|disabled
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── Project ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      text NOT NULL,
  status                    text NOT NULL DEFAULT 'active',  -- active|archived
  owner_id                  uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  current_graph_version_id  uuid,                            -- 原子切换，循环引用故不加 FK
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);

-- ── 成员 ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_members (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL,                          -- owner|editor
  joined_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON project_members(user_id);

-- ── 邀请密钥(仅存哈希) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key_hash    text NOT NULL,
  role        text NOT NULL DEFAULT 'editor',        -- editor
  max_uses    int,                                   -- NULL = unlimited
  used_count  int  NOT NULL DEFAULT 0,
  expires_at  timestamptz,
  revoked_at  timestamptz,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_key_hash ON invitations(key_hash);
CREATE INDEX IF NOT EXISTS idx_invitations_project ON invitations(project_id, created_at DESC);

-- ── 仓库绑定(一 Project 一仓库) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS repository_bindings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  provider           text NOT NULL DEFAULT 'github',
  repo_full_name     text NOT NULL,
  repository_id      bigint,
  installation_id    bigint,
  branch             text NOT NULL,
  current_commit_sha text,
  webhook_secret_ref text,                           -- 只存引用，绝不存明文密钥
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bindings_repo ON repository_bindings(repo_full_name, branch);

-- ── 分析任务 ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS analysis_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type              text NOT NULL,                   -- full|incremental
  status            text NOT NULL DEFAULT 'queued',  -- queued|running|succeeded|failed|canceled
  base_commit_sha   text,
  target_commit_sha text,
  progress          smallint NOT NULL DEFAULT 0,
  error             text,
  credits           numeric(10,3),
  dedup_key         text UNIQUE,                     -- project_id + target_sha + type
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at        timestamptz,
  finished_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jobs_project_created ON analysis_jobs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON analysis_jobs(status);

-- ── 图谱版本(只追加，严格绑定 commit) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS graph_versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_no       int  NOT NULL,
  commit_sha       text NOT NULL,
  job_id           uuid REFERENCES analysis_jobs(id) ON DELETE SET NULL,
  artifact_oss_key text NOT NULL,                    -- MVP：ARTIFACTS_DIR 下相对路径
  report_oss_key   text,
  stats            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, version_no)
);
CREATE INDEX IF NOT EXISTS idx_graph_versions_sha ON graph_versions(project_id, commit_sha);

-- ── 文档(全局/模块，含钉钉链接) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS document_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope          text NOT NULL,                      -- global|module
  node_id        text,                               -- scope=module 时必填
  title          text NOT NULL,
  url            text NOT NULL,
  doc_type       text NOT NULL DEFAULT 'external',   -- dingtalk|external|generated
  status         text NOT NULL DEFAULT 'ok',         -- ok|maybe_stale
  last_synced_at timestamptz,
  updated_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_documents_project ON document_links(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_node ON document_links(project_id, node_id);

CREATE TABLE IF NOT EXISTS document_revisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id       uuid NOT NULL REFERENCES document_links(id) ON DELETE CASCADE,
  snapshot_oss_key  text,
  snapshot          jsonb,                           -- MVP：小快照直接入库
  change_note       text,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_doc_revisions_doc ON document_revisions(document_id, created_at DESC);

-- ── 批注 ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS annotations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_kind text NOT NULL,                         -- node|edge
  target_id   text NOT NULL,
  body        text NOT NULL,
  author_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_annotations_project ON annotations(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_annotations_target ON annotations(project_id, target_id);

-- ── 审计日志 ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id          bigserial PRIMARY KEY,
  project_id  uuid,
  actor_id    uuid,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  detail      jsonb,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_project_created ON audit_logs(project_id, created_at DESC);

-- ── Webhook 幂等(delivery_id 防重放) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id text PRIMARY KEY,
  event       text,
  received_at timestamptz NOT NULL DEFAULT now()
);
