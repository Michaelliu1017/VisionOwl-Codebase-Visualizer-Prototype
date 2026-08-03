"use strict";

const { Pool } = require("pg");
const { CloudError } = require("../errors");
const { postgresPoolOptions } = require("./pool-options");

function iso(value) {
  return value ? new Date(value).toISOString() : undefined;
}

function user(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function session(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    userId: row.user_id,
    accessTokenHash: row.access_token_hash,
    refreshTokenHash: row.refresh_token_hash,
    accessExpiresAt: iso(row.access_expires_at),
    refreshExpiresAt: iso(row.refresh_expires_at),
    revokedAt: iso(row.revoked_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function project(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    description: row.description,
    repositoryFingerprint: row.repository_fingerprint || undefined,
    defaultBranch: row.default_branch,
    currentGraphVersionId: row.current_graph_version_id || undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.role ? { role: row.role } : {}),
  };
}

function member(row) {
  if (!row) return undefined;
  return {
    projectId: row.project_id,
    userId: row.user_id,
    role: row.role,
    joinedAt: iso(row.joined_at),
    updatedAt: iso(row.updated_at),
    ...(row.email ? { email: row.email } : {}),
    ...(row.display_name ? { displayName: row.display_name } : {}),
  };
}

function invite(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    projectId: row.project_id,
    tokenHash: row.token_hash,
    role: row.role,
    maxUses: Number(row.max_uses),
    useCount: Number(row.use_count),
    expiresAt: iso(row.expires_at),
    revokedAt: iso(row.revoked_at),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
  };
}

function graphVersion(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    projectId: row.project_id,
    parentVersionId: row.parent_version_id || undefined,
    source: row.source,
    branch: row.branch,
    commit: row.commit_hash,
    status: row.status,
    checksum: row.checksum,
    artifact: row.artifact_json,
    artifactUri: row.artifact_uri || undefined,
    engineVersion: row.engine_version || undefined,
    skillVersion: row.skill_version || undefined,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    activatedAt: iso(row.activated_at),
  };
}

function document(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    projectId: row.project_id,
    stableEntityId: row.stable_entity_id || undefined,
    scope: row.scope,
    provider: row.provider,
    externalId: row.external_id || undefined,
    title: row.title,
    url: row.url,
    summary: row.summary,
    syncStatus: row.sync_status,
    version: Number(row.version),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function annotation(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    projectId: row.project_id,
    stableEntityId: row.stable_entity_id,
    body: row.body,
    version: Number(row.version),
    createdBy: row.created_by,
    author: row.display_name || undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    deletedAt: iso(row.deleted_at),
  };
}

function realtimeEvent(row) {
  if (!row) return undefined;
  return {
    sequence: Number(row.sequence),
    projectId: row.project_id,
    type: row.event_type,
    payload: row.payload || {},
    actorId: row.actor_id || undefined,
    createdAt: iso(row.created_at),
  };
}

class PostgresStore {
  constructor(databaseUrl, options = {}) {
    if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL store.");
    this.pool = options.pool || new Pool({
      ...postgresPoolOptions(databaseUrl),
      max: Number(process.env.PGPOOL_MAX || 12),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
    });
  }

  async close() {
    await this.pool.end();
  }

  async ping() {
    await this.pool.query("SELECT 1");
    return true;
  }

  async createUser(value) {
    try {
      const result = await this.pool.query(
        `INSERT INTO users(id, email, display_name, password_hash, status, created_at, updated_at)
         VALUES($1, $2, $3, $4, $5, $6, $6) RETURNING *`,
        [value.id, value.email, value.displayName, value.passwordHash, value.status, value.createdAt],
      );
      return user(result.rows[0]);
    } catch (error) {
      if (error.code === "23505") {
        throw new CloudError(409, "email_exists", "An account already exists for this email.");
      }
      throw error;
    }
  }

  async userByEmail(email) {
    const result = await this.pool.query("SELECT * FROM users WHERE LOWER(email) = LOWER($1)", [email]);
    return user(result.rows[0]);
  }

  async userById(id) {
    const result = await this.pool.query("SELECT * FROM users WHERE id = $1", [id]);
    return user(result.rows[0]);
  }

  async createSession(value) {
    const result = await this.pool.query(
      `INSERT INTO sessions
       (id, user_id, access_token_hash, refresh_token_hash, access_expires_at,
        refresh_expires_at, created_at, updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`,
      [
        value.id,
        value.userId,
        value.accessTokenHash,
        value.refreshTokenHash,
        value.accessExpiresAt,
        value.refreshExpiresAt,
        value.createdAt,
      ],
    );
    return session(result.rows[0]);
  }

  async sessionByAccessHash(hash) {
    const result = await this.pool.query(
      "SELECT * FROM sessions WHERE access_token_hash = $1",
      [hash],
    );
    return session(result.rows[0]);
  }

  async sessionByRefreshHash(hash) {
    const result = await this.pool.query(
      "SELECT * FROM sessions WHERE refresh_token_hash = $1",
      [hash],
    );
    return session(result.rows[0]);
  }

  async rotateSession(id, value) {
    const result = await this.pool.query(
      `UPDATE sessions SET access_token_hash=$2, refresh_token_hash=$3,
       access_expires_at=$4, refresh_expires_at=$5, updated_at=$6
       WHERE id=$1 AND revoked_at IS NULL RETURNING *`,
      [
        id,
        value.accessTokenHash,
        value.refreshTokenHash,
        value.accessExpiresAt,
        value.refreshExpiresAt,
        value.updatedAt,
      ],
    );
    return session(result.rows[0]);
  }

  async revokeSession(id, revokedAt) {
    await this.pool.query(
      "UPDATE sessions SET revoked_at=$2, updated_at=$2 WHERE id=$1 AND revoked_at IS NULL",
      [id, revokedAt],
    );
  }

  async createProject(value, ownerMembership) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const created = await client.query(
        `INSERT INTO projects
         (id, owner_id, name, description, repository_fingerprint, default_branch, created_at, updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`,
        [
          value.id,
          value.ownerId,
          value.name,
          value.description,
          value.repositoryFingerprint || null,
          value.defaultBranch,
          value.createdAt,
        ],
      );
      await client.query(
        `INSERT INTO project_members(project_id,user_id,role,joined_at,updated_at)
         VALUES($1,$2,'owner',$3,$3)`,
        [value.id, ownerMembership.userId, ownerMembership.joinedAt],
      );
      await client.query("COMMIT");
      return { ...project(created.rows[0]), role: "owner" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listProjects(userId) {
    const result = await this.pool.query(
      `SELECT p.*, m.role FROM projects p
       JOIN project_members m ON m.project_id=p.id
       WHERE m.user_id=$1 ORDER BY p.updated_at DESC`,
      [userId],
    );
    return result.rows.map(project);
  }

  async projectById(projectId) {
    const result = await this.pool.query("SELECT * FROM projects WHERE id=$1", [projectId]);
    return project(result.rows[0]);
  }

  async member(projectId, userId) {
    const result = await this.pool.query(
      "SELECT * FROM project_members WHERE project_id=$1 AND user_id=$2",
      [projectId, userId],
    );
    return member(result.rows[0]);
  }

  async listMembers(projectId) {
    const result = await this.pool.query(
      `SELECT m.*, u.email, u.display_name FROM project_members m
       JOIN users u ON u.id=m.user_id WHERE m.project_id=$1 ORDER BY m.joined_at`,
      [projectId],
    );
    return result.rows.map(member);
  }

  async setMemberRole(projectId, userId, role, updatedAt) {
    const result = await this.pool.query(
      `UPDATE project_members SET role=$3,updated_at=$4
       WHERE project_id=$1 AND user_id=$2 RETURNING *`,
      [projectId, userId, role, updatedAt],
    );
    return member(result.rows[0]);
  }

  async removeMember(projectId, userId) {
    const result = await this.pool.query(
      "DELETE FROM project_members WHERE project_id=$1 AND user_id=$2",
      [projectId, userId],
    );
    return result.rowCount > 0;
  }

  async createInvite(value) {
    const result = await this.pool.query(
      `INSERT INTO project_invites
       (id,project_id,token_hash,role,max_uses,use_count,expires_at,created_by,created_at)
       VALUES($1,$2,$3,$4,$5,0,$6,$7,$8) RETURNING *`,
      [
        value.id,
        value.projectId,
        value.tokenHash,
        value.role,
        value.maxUses,
        value.expiresAt,
        value.createdBy,
        value.createdAt,
      ],
    );
    return invite(result.rows[0]);
  }

  async listInvites(projectId) {
    const result = await this.pool.query(
      "SELECT * FROM project_invites WHERE project_id=$1 ORDER BY created_at DESC",
      [projectId],
    );
    return result.rows.map(invite);
  }

  async revokeInvite(projectId, inviteId, revokedAt) {
    const result = await this.pool.query(
      `UPDATE project_invites SET revoked_at=$3
       WHERE project_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING *`,
      [projectId, inviteId, revokedAt],
    );
    return invite(result.rows[0]);
  }

  async redeemInvite(hash, userId, now) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(
        "SELECT * FROM project_invites WHERE token_hash=$1 FOR UPDATE",
        [hash],
      );
      const value = invite(selected.rows[0]);
      if (!value) throw new CloudError(404, "invite_invalid", "Invitation is invalid.");
      if (value.revokedAt) throw new CloudError(410, "invite_revoked", "Invitation was revoked.");
      if (Date.parse(value.expiresAt) <= Date.parse(now)) {
        throw new CloudError(410, "invite_expired", "Invitation has expired.");
      }
      if (value.useCount >= value.maxUses) {
        throw new CloudError(410, "invite_exhausted", "Invitation has no remaining uses.");
      }
      const existing = await client.query(
        "SELECT * FROM project_members WHERE project_id=$1 AND user_id=$2",
        [value.projectId, userId],
      );
      let membership = member(existing.rows[0]);
      if (!membership) {
        const inserted = await client.query(
          `INSERT INTO project_members(project_id,user_id,role,joined_at,updated_at)
           VALUES($1,$2,$3,$4,$4) RETURNING *`,
          [value.projectId, userId, value.role, now],
        );
        membership = member(inserted.rows[0]);
        await client.query(
          "UPDATE project_invites SET use_count=use_count+1 WHERE id=$1",
          [value.id],
        );
        value.useCount += 1;
      }
      const projectResult = await client.query("SELECT * FROM projects WHERE id=$1", [value.projectId]);
      await client.query("COMMIT");
      return { invite: value, project: project(projectResult.rows[0]), member: membership };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createGraphVersion(value) {
    const result = await this.pool.query(
      `INSERT INTO graph_versions
       (id,project_id,parent_version_id,source,branch,commit_hash,status,checksum,
        artifact_json,artifact_uri,engine_version,skill_version,created_by,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14) RETURNING *`,
      [
        value.id,
        value.projectId,
        value.parentVersionId || null,
        value.source,
        value.branch,
        value.commit,
        value.status,
        value.checksum,
        JSON.stringify(value.artifact),
        value.artifactUri || null,
        value.engineVersion || null,
        value.skillVersion || null,
        value.createdBy,
        value.createdAt,
      ],
    );
    return graphVersion(result.rows[0]);
  }

  async graphVersion(projectId, versionId) {
    const result = await this.pool.query(
      "SELECT * FROM graph_versions WHERE project_id=$1 AND id=$2",
      [projectId, versionId],
    );
    return graphVersion(result.rows[0]);
  }

  async listGraphVersions(projectId) {
    const result = await this.pool.query(
      "SELECT * FROM graph_versions WHERE project_id=$1 ORDER BY created_at DESC",
      [projectId],
    );
    return result.rows.map(graphVersion);
  }

  async currentGraph(projectId) {
    const result = await this.pool.query(
      `SELECT g.* FROM projects p
       JOIN graph_versions g ON g.id=p.current_graph_version_id
       WHERE p.id=$1`,
      [projectId],
    );
    return graphVersion(result.rows[0]);
  }

  async activateGraphVersion(projectId, versionId, activatedAt) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const projectResult = await client.query(
        "SELECT * FROM projects WHERE id=$1 FOR UPDATE",
        [projectId],
      );
      const currentProject = project(projectResult.rows[0]);
      const versionResult = await client.query(
        "SELECT * FROM graph_versions WHERE project_id=$1 AND id=$2 FOR UPDATE",
        [projectId, versionId],
      );
      const version = graphVersion(versionResult.rows[0]);
      if (!currentProject || !version) {
        await client.query("ROLLBACK");
        return undefined;
      }
      if (!["ready", "active", "archived"].includes(version.status)) {
        throw new CloudError(409, "graph_not_ready", "Graph version is not ready for activation.");
      }
      if (currentProject.currentGraphVersionId && currentProject.currentGraphVersionId !== versionId) {
        await client.query(
          "UPDATE graph_versions SET status='archived' WHERE id=$1",
          [currentProject.currentGraphVersionId],
        );
      }
      const activated = await client.query(
        "UPDATE graph_versions SET status='active',activated_at=$3 WHERE project_id=$1 AND id=$2 RETURNING *",
        [projectId, versionId, activatedAt],
      );
      const updatedProject = await client.query(
        "UPDATE projects SET current_graph_version_id=$2,updated_at=$3 WHERE id=$1 RETURNING *",
        [projectId, versionId, activatedAt],
      );
      await client.query("COMMIT");
      return { project: project(updatedProject.rows[0]), version: graphVersion(activated.rows[0]) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listDocuments(projectId) {
    const result = await this.pool.query(
      "SELECT * FROM documents WHERE project_id=$1 ORDER BY updated_at DESC",
      [projectId],
    );
    return result.rows.map(document);
  }

  async createDocument(value) {
    const result = await this.pool.query(
      `INSERT INTO documents
       (id,project_id,stable_entity_id,scope,provider,external_id,title,url,summary,
        sync_status,version,created_by,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12,$12) RETURNING *`,
      [
        value.id,
        value.projectId,
        value.stableEntityId || null,
        value.scope,
        value.provider,
        value.externalId || null,
        value.title,
        value.url,
        value.summary,
        value.syncStatus,
        value.createdBy,
        value.createdAt,
      ],
    );
    return document(result.rows[0]);
  }

  async updateDocument(projectId, documentId, value) {
    const result = await this.pool.query(
      `UPDATE documents SET title=COALESCE($3,title),url=COALESCE($4,url),
       summary=COALESCE($5,summary),sync_status=COALESCE($6,sync_status),
       version=version+1,updated_at=$7
       WHERE project_id=$1 AND id=$2 RETURNING *`,
      [
        projectId,
        documentId,
        value.title ?? null,
        value.url ?? null,
        value.summary ?? null,
        value.syncStatus ?? null,
        value.updatedAt,
      ],
    );
    return document(result.rows[0]);
  }

  async deleteDocument(projectId, documentId) {
    const result = await this.pool.query(
      "DELETE FROM documents WHERE project_id=$1 AND id=$2",
      [projectId, documentId],
    );
    return result.rowCount > 0;
  }

  async listAnnotations(projectId, entityId) {
    const values = [projectId];
    let filter = "a.project_id=$1 AND a.deleted_at IS NULL";
    if (entityId) {
      values.push(entityId);
      filter += " AND a.stable_entity_id=$2";
    }
    const result = await this.pool.query(
      `SELECT a.*,u.display_name FROM annotations a
       JOIN users u ON u.id=a.created_by WHERE ${filter} ORDER BY a.created_at`,
      values,
    );
    return result.rows.map(annotation);
  }

  async createAnnotation(value) {
    const result = await this.pool.query(
      `WITH inserted AS (
         INSERT INTO annotations
         (id,project_id,stable_entity_id,body,version,created_by,created_at,updated_at)
         VALUES($1,$2,$3,$4,1,$5,$6,$6) RETURNING *
       ) SELECT inserted.*,u.display_name FROM inserted
       JOIN users u ON u.id=inserted.created_by`,
      [value.id, value.projectId, value.stableEntityId, value.body, value.createdBy, value.createdAt],
    );
    return annotation(result.rows[0]);
  }

  async updateAnnotation(projectId, annotationId, userId, value, expectedVersion, owner) {
    const values = [projectId, annotationId, value.body, value.updatedAt, userId];
    let filter = "project_id=$1 AND id=$2 AND deleted_at IS NULL";
    if (!owner) filter += " AND created_by=$5";
    if (expectedVersion) {
      values.push(expectedVersion);
      filter += ` AND version=$${values.length}`;
    }
    const result = await this.pool.query(
      `WITH updated AS (
         UPDATE annotations SET body=$3,updated_at=$4,version=version+1
         WHERE ${filter} RETURNING *
       ) SELECT updated.*,u.display_name FROM updated
       JOIN users u ON u.id=updated.created_by`,
      values,
    );
    if (!result.rows[0] && expectedVersion) {
      throw new CloudError(409, "annotation_conflict", "Annotation changed or is not editable.");
    }
    return annotation(result.rows[0]);
  }

  async deleteAnnotation(projectId, annotationId, userId, deletedAt, owner) {
    const result = await this.pool.query(
      `WITH updated AS (
         UPDATE annotations SET deleted_at=$4,updated_at=$4,version=version+1
         WHERE project_id=$1 AND id=$2 AND deleted_at IS NULL
         AND ($5::boolean OR created_by=$3) RETURNING *
       ) SELECT updated.*,u.display_name FROM updated
       JOIN users u ON u.id=updated.created_by`,
      [projectId, annotationId, userId, deletedAt, owner],
    );
    return annotation(result.rows[0]);
  }

  async appendEvent(value) {
    const result = await this.pool.query(
      `INSERT INTO realtime_events(project_id,event_type,payload,actor_id,created_at)
       VALUES($1,$2,$3::jsonb,$4,$5) RETURNING *`,
      [value.projectId, value.type, JSON.stringify(value.payload || {}), value.actorId || null, value.createdAt],
    );
    return realtimeEvent(result.rows[0]);
  }

  async eventsAfter(projectId, after = 0, limit = 200) {
    const result = await this.pool.query(
      `SELECT * FROM realtime_events WHERE project_id=$1 AND sequence>$2
       ORDER BY sequence LIMIT $3`,
      [projectId, after, limit],
    );
    return result.rows.map(realtimeEvent);
  }

  async createRealtimeTicket(value) {
    await this.pool.query(
      `INSERT INTO realtime_tickets(token_hash,project_id,user_id,expires_at,created_at)
       VALUES($1,$2,$3,$4,$5)`,
      [value.tokenHash, value.projectId, value.userId, value.expiresAt, value.createdAt],
    );
  }

  async consumeRealtimeTicket(hash, now) {
    const result = await this.pool.query(
      `UPDATE realtime_tickets SET consumed_at=$2
       WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>$2
       RETURNING *`,
      [hash, now],
    );
    const row = result.rows[0];
    return row
      ? {
          tokenHash: row.token_hash,
          projectId: row.project_id,
          userId: row.user_id,
          expiresAt: iso(row.expires_at),
          consumedAt: iso(row.consumed_at),
          createdAt: iso(row.created_at),
        }
      : undefined;
  }

  async audit(value) {
    await this.pool.query(
      `INSERT INTO audit_logs
       (id,project_id,actor_id,action,target_type,target_id,metadata,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [
        value.id,
        value.projectId || null,
        value.actorId || null,
        value.action,
        value.targetType,
        value.targetId || null,
        JSON.stringify(value.metadata || {}),
        value.createdAt,
      ],
    );
  }
}

module.exports = { PostgresStore };
