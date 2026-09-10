-- VisionOwl 用户与钉钉 DWS 身份绑定。
-- OAuth token 不入库，由 DWS 在每用户独立 HOME 下加密保存。

CREATE TABLE IF NOT EXISTS dingtalk_connections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_key       text NOT NULL,
  corp_id           text NOT NULL,
  corp_name         text NOT NULL DEFAULT '',
  dingtalk_user_id  text NOT NULL,
  user_name         text NOT NULL DEFAULT '',
  status            text NOT NULL DEFAULT 'active',
  is_default        boolean NOT NULL DEFAULT false,
  workspace_id      text,
  folder_id         text,
  last_verified_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, profile_key)
);

CREATE INDEX IF NOT EXISTS idx_dingtalk_connections_user
  ON dingtalk_connections(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dingtalk_connections_default
  ON dingtalk_connections(user_id) WHERE is_default;

ALTER TABLE document_links
  ADD COLUMN IF NOT EXISTS generated_by_ai boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS artifact_oss_key text,
  ADD COLUMN IF NOT EXISTS dingtalk_connection_id uuid REFERENCES dingtalk_connections(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dingtalk_node_id text,
  ADD COLUMN IF NOT EXISTS sync_error text;

UPDATE document_links
   SET generated_by_ai = true,
       artifact_oss_key = CASE
         WHEN url LIKE 'visionowl://artifact/%' THEN substring(url FROM length('visionowl://artifact/') + 1)
         ELSE artifact_oss_key
       END
 WHERE doc_type = 'generated';

CREATE INDEX IF NOT EXISTS idx_documents_generated_node
  ON document_links(project_id, generated_by_ai, scope, node_id);
