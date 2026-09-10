-- VisionOwl collaboration roles: owner/editor only.
-- Existing viewers become editors; every active invitation becomes permanent
-- and unlimited. The invitation secret remains revocable and hash-only.

UPDATE project_members SET role = 'editor' WHERE role = 'viewer';
UPDATE invitations SET role = 'editor' WHERE role = 'viewer';

ALTER TABLE invitations ALTER COLUMN role SET DEFAULT 'editor';
ALTER TABLE invitations ALTER COLUMN max_uses DROP NOT NULL;
ALTER TABLE invitations ALTER COLUMN max_uses DROP DEFAULT;

UPDATE invitations
   SET max_uses = NULL,
       expires_at = NULL
 WHERE revoked_at IS NULL;
