"use strict";

const { CloudError } = require("../errors");

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

class MemoryStore {
  constructor() {
    this.users = new Map();
    this.sessions = new Map();
    this.projects = new Map();
    this.members = new Map();
    this.invites = new Map();
    this.graphVersions = new Map();
    this.documents = new Map();
    this.annotations = new Map();
    this.events = [];
    this.tickets = new Map();
    this.audits = [];
    this.sequence = 0;
  }

  async close() {}
  async ping() {
    return true;
  }

  async createUser(user) {
    if ([...this.users.values()].some((item) => item.email.toLowerCase() === user.email.toLowerCase())) {
      throw new CloudError(409, "email_exists", "An account already exists for this email.");
    }
    this.users.set(user.id, clone(user));
    return clone(user);
  }

  async userByEmail(email) {
    return clone(
      [...this.users.values()].find((user) => user.email.toLowerCase() === email.toLowerCase()),
    );
  }

  async userById(id) {
    return clone(this.users.get(id));
  }

  async createSession(session) {
    this.sessions.set(session.id, clone(session));
    return clone(session);
  }

  async sessionByAccessHash(hash) {
    return clone([...this.sessions.values()].find((session) => session.accessTokenHash === hash));
  }

  async sessionByRefreshHash(hash) {
    return clone([...this.sessions.values()].find((session) => session.refreshTokenHash === hash));
  }

  async rotateSession(id, values) {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    Object.assign(session, clone(values));
    return clone(session);
  }

  async revokeSession(id, revokedAt) {
    const session = this.sessions.get(id);
    if (session) session.revokedAt = revokedAt;
  }

  async createProject(project, ownerMembership) {
    this.projects.set(project.id, clone(project));
    this.members.set(
      `${project.id}:${ownerMembership.userId}`,
      clone({ ...ownerMembership, projectId: project.id }),
    );
    return { ...clone(project), role: "owner" };
  }

  async listProjects(userId) {
    return [...this.projects.values()]
      .map((project) => {
        const member = this.members.get(`${project.id}:${userId}`);
        return member ? { ...clone(project), role: member.role } : undefined;
      })
      .filter(Boolean)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async projectById(projectId) {
    return clone(this.projects.get(projectId));
  }

  async member(projectId, userId) {
    return clone(this.members.get(`${projectId}:${userId}`));
  }

  async listMembers(projectId) {
    const result = [];
    for (const member of this.members.values()) {
      if (member.projectId !== projectId) continue;
      const user = this.users.get(member.userId);
      result.push({
        ...clone(member),
        email: user?.email || "",
        displayName: user?.displayName || "Unknown user",
      });
    }
    return result.sort((left, right) => left.joinedAt.localeCompare(right.joinedAt));
  }

  async setMemberRole(projectId, userId, role, updatedAt) {
    const member = this.members.get(`${projectId}:${userId}`);
    if (!member) return undefined;
    member.role = role;
    member.updatedAt = updatedAt;
    return clone(member);
  }

  async removeMember(projectId, userId) {
    return this.members.delete(`${projectId}:${userId}`);
  }

  async createInvite(invite) {
    this.invites.set(invite.id, clone(invite));
    return clone(invite);
  }

  async listInvites(projectId) {
    return [...this.invites.values()]
      .filter((invite) => invite.projectId === projectId)
      .map(clone)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async revokeInvite(projectId, inviteId, revokedAt) {
    const invite = this.invites.get(inviteId);
    if (!invite || invite.projectId !== projectId) return undefined;
    invite.revokedAt = revokedAt;
    return clone(invite);
  }

  async redeemInvite(tokenHash, userId, now) {
    const invite = [...this.invites.values()].find((item) => item.tokenHash === tokenHash);
    if (!invite) throw new CloudError(404, "invite_invalid", "Invitation is invalid.");
    if (invite.revokedAt) throw new CloudError(410, "invite_revoked", "Invitation was revoked.");
    if (Date.parse(invite.expiresAt) <= Date.parse(now)) {
      throw new CloudError(410, "invite_expired", "Invitation has expired.");
    }
    if (invite.useCount >= invite.maxUses) {
      throw new CloudError(410, "invite_exhausted", "Invitation has no remaining uses.");
    }
    const key = `${invite.projectId}:${userId}`;
    let member = this.members.get(key);
    if (!member) {
      member = {
        projectId: invite.projectId,
        userId,
        role: invite.role,
        joinedAt: now,
        updatedAt: now,
      };
      this.members.set(key, member);
      invite.useCount += 1;
    }
    return {
      invite: clone(invite),
      project: clone(this.projects.get(invite.projectId)),
      member: clone(member),
    };
  }

  async createGraphVersion(version) {
    this.graphVersions.set(version.id, clone(version));
    return clone(version);
  }

  async graphVersion(projectId, versionId) {
    const version = this.graphVersions.get(versionId);
    return version?.projectId === projectId ? clone(version) : undefined;
  }

  async listGraphVersions(projectId) {
    return [...this.graphVersions.values()]
      .filter((version) => version.projectId === projectId)
      .map(clone)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async currentGraph(projectId) {
    const project = this.projects.get(projectId);
    if (!project?.currentGraphVersionId) return undefined;
    return clone(this.graphVersions.get(project.currentGraphVersionId));
  }

  async activateGraphVersion(projectId, versionId, activatedAt) {
    const project = this.projects.get(projectId);
    const version = this.graphVersions.get(versionId);
    if (!project || !version || version.projectId !== projectId) return undefined;
    if (!new Set(["ready", "active", "archived"]).has(version.status)) {
      throw new CloudError(409, "graph_not_ready", "Graph version is not ready for activation.");
    }
    const previousId = project.currentGraphVersionId;
    if (previousId && previousId !== versionId) {
      const previous = this.graphVersions.get(previousId);
      if (previous) previous.status = "archived";
    }
    version.status = "active";
    version.activatedAt = activatedAt;
    project.currentGraphVersionId = versionId;
    project.updatedAt = activatedAt;
    return { project: clone(project), version: clone(version) };
  }

  async listDocuments(projectId) {
    return [...this.documents.values()]
      .filter((document) => document.projectId === projectId)
      .map(clone)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async createDocument(document) {
    this.documents.set(document.id, clone(document));
    return clone(document);
  }

  async updateDocument(projectId, documentId, values) {
    const document = this.documents.get(documentId);
    if (!document || document.projectId !== projectId) return undefined;
    Object.assign(document, clone(values), { version: document.version + 1 });
    return clone(document);
  }

  async deleteDocument(projectId, documentId) {
    const document = this.documents.get(documentId);
    if (!document || document.projectId !== projectId) return false;
    return this.documents.delete(documentId);
  }

  async listAnnotations(projectId, entityId) {
    return [...this.annotations.values()]
      .filter(
        (annotation) =>
          annotation.projectId === projectId &&
          !annotation.deletedAt &&
          (!entityId || annotation.stableEntityId === entityId),
      )
      .map(clone)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async createAnnotation(annotation) {
    this.annotations.set(annotation.id, clone(annotation));
    return clone(annotation);
  }

  async updateAnnotation(projectId, annotationId, userId, values, expectedVersion, owner) {
    const annotation = this.annotations.get(annotationId);
    if (!annotation || annotation.projectId !== projectId || annotation.deletedAt) return undefined;
    if (!owner && annotation.createdBy !== userId) {
      throw new CloudError(403, "permission_denied", "Only the annotation author can edit it.");
    }
    if (expectedVersion && annotation.version !== expectedVersion) {
      throw new CloudError(409, "annotation_conflict", "Annotation was updated by another member.");
    }
    Object.assign(annotation, clone(values), { version: annotation.version + 1 });
    return clone(annotation);
  }

  async deleteAnnotation(projectId, annotationId, userId, deletedAt, owner) {
    const annotation = this.annotations.get(annotationId);
    if (!annotation || annotation.projectId !== projectId || annotation.deletedAt) return undefined;
    if (!owner && annotation.createdBy !== userId) {
      throw new CloudError(403, "permission_denied", "Only the annotation author can delete it.");
    }
    annotation.deletedAt = deletedAt;
    annotation.updatedAt = deletedAt;
    annotation.version += 1;
    return clone(annotation);
  }

  async appendEvent(event) {
    const value = { ...clone(event), sequence: ++this.sequence };
    this.events.push(value);
    return clone(value);
  }

  async eventsAfter(projectId, after = 0, limit = 200) {
    return this.events
      .filter((event) => event.projectId === projectId && event.sequence > after)
      .slice(0, limit)
      .map(clone);
  }

  async createRealtimeTicket(ticket) {
    this.tickets.set(ticket.tokenHash, clone(ticket));
  }

  async consumeRealtimeTicket(tokenHash, now) {
    const ticket = this.tickets.get(tokenHash);
    if (!ticket || ticket.consumedAt || Date.parse(ticket.expiresAt) <= Date.parse(now)) {
      return undefined;
    }
    ticket.consumedAt = now;
    return clone(ticket);
  }

  async audit(entry) {
    this.audits.push(clone(entry));
  }
}

module.exports = { MemoryStore };
