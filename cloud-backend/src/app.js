"use strict";

const http = require("node:http");
const { createHash, randomUUID } = require("node:crypto");
const { WebSocketServer } = require("ws");
const {
  validateSanitizedGraphArtifact,
} = require("@visionowl/graph-sanitizer");
const { CloudError, assert } = require("./errors");
const { matchPath, readJson, sendJson } = require("./http-utils");
const { RealtimeHub } = require("./realtime/hub");
const {
  hashPassword,
  randomToken,
  tokenHash,
  verifyPassword,
} = require("./security/credentials");
const { requireRole, validRole } = require("./security/permissions");

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/i;

function nowIso(clock) {
  return clock().toISOString();
}

function plusSeconds(clock, seconds) {
  return new Date(clock().getTime() + seconds * 1000).toISOString();
}

function publicUser(value) {
  return value
    ? {
        id: value.id,
        email: value.email,
        displayName: value.displayName,
        status: value.status,
        createdAt: value.createdAt,
      }
    : undefined;
}

function publicInvite(value, token) {
  return {
    id: value.id,
    projectId: value.projectId,
    role: value.role,
    maxUses: value.maxUses,
    useCount: value.useCount,
    expiresAt: value.expiresAt,
    revokedAt: value.revokedAt,
    createdAt: value.createdAt,
    ...(token ? { token } : {}),
  };
}

function publicGraphVersion(value, includeArtifact = false) {
  if (!value) return undefined;
  return {
    id: value.id,
    projectId: value.projectId,
    parentVersionId: value.parentVersionId,
    source: value.source,
    branch: value.branch,
    commit: value.commit,
    status: value.status,
    checksum: value.checksum,
    artifactUri: value.artifactUri,
    engineVersion: value.engineVersion,
    skillVersion: value.skillVersion,
    createdBy: value.createdBy,
    createdAt: value.createdAt,
    activatedAt: value.activatedAt,
    ...(includeArtifact ? { artifact: value.artifact } : {}),
  };
}

function publicDocument(value) {
  return {
    id: value.id,
    projectId: value.projectId,
    stableEntityId: value.stableEntityId,
    scope: value.scope,
    provider: value.provider,
    externalId: value.externalId,
    title: value.title,
    url: value.url,
    summary: value.summary,
    syncStatus: value.syncStatus,
    version: value.version,
    createdBy: value.createdBy,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function publicAnnotation(value) {
  return {
    id: value.id,
    projectId: value.projectId,
    stableEntityId: value.stableEntityId,
    author: value.author || "Team member",
    body: value.body,
    version: value.version,
    createdBy: value.createdBy,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  assert(EMAIL_PATTERN.test(email) && email.length <= 320, 400, "email_invalid", "Email is invalid.");
  return email;
}

function requiredText(value, field, maximum = 240) {
  const text = String(value || "").trim();
  assert(text.length > 0 && text.length <= maximum, 400, `${field}_invalid`, `${field} is required.`);
  return text;
}

function optionalText(value, maximum = 2000) {
  return String(value || "").trim().slice(0, maximum);
}

function validUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch (_error) {
    return false;
  }
}

function checksum(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function createCloudApp({ store, config, clock = () => new Date(), logger = console }) {
  const hub = new RealtimeHub();
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  async function audit({ projectId, actorId, action, targetType, targetId, metadata }) {
    await store.audit({
      id: randomUUID(),
      projectId,
      actorId,
      action,
      targetType,
      targetId,
      metadata: metadata || {},
      createdAt: nowIso(clock),
    });
  }

  async function emit(projectId, type, payload, actorId) {
    const event = await store.appendEvent({
      projectId,
      type,
      payload: payload || {},
      actorId,
      createdAt: nowIso(clock),
    });
    hub.publish(event);
    return event;
  }

  async function createSessionBundle(user) {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const createdAt = nowIso(clock);
    const session = await store.createSession({
      id: randomUUID(),
      userId: user.id,
      accessTokenHash: tokenHash(accessToken),
      refreshTokenHash: tokenHash(refreshToken),
      accessExpiresAt: plusSeconds(clock, config.accessTokenTtlSeconds),
      refreshExpiresAt: plusSeconds(clock, config.refreshTokenTtlSeconds),
      createdAt,
      updatedAt: createdAt,
    });
    return {
      user: publicUser(user),
      accessToken,
      refreshToken,
      accessExpiresAt: session.accessExpiresAt,
      refreshExpiresAt: session.refreshExpiresAt,
    };
  }

  async function authenticate(request) {
    const authorization = request.headers.authorization || "";
    const [scheme, token] = authorization.split(" ");
    assert(scheme === "Bearer" && token, 401, "authentication_required", "Sign in is required.");
    const session = await store.sessionByAccessHash(tokenHash(token));
    assert(
      session && !session.revokedAt && Date.parse(session.accessExpiresAt) > clock().getTime(),
      401,
      "session_expired",
      "Session is invalid or expired.",
    );
    const user = await store.userById(session.userId);
    assert(user?.status === "active", 401, "account_unavailable", "Account is unavailable.");
    return { user, session };
  }

  async function authorize(request, projectId, role = "viewer") {
    const auth = await authenticate(request);
    const membership = await store.member(projectId, auth.user.id);
    requireRole(membership, role);
    const project = await store.projectById(projectId);
    assert(project, 404, "project_not_found", "Project not found.");
    return { ...auth, membership, project };
  }

  function corsHeaders(request) {
    const origin = request.headers.origin;
    if (!origin) return {};
    assert(
      config.allowedOrigins.includes(origin),
      403,
      "origin_not_allowed",
      "Request origin is not allowed.",
    );
    return {
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Authorization,Content-Type,X-Request-ID",
      "Access-Control-Max-Age": "600",
    };
  }

  async function route(request, response) {
    const requestUrl = new URL(request.url, "http://visionowl.local");
    const pathname = requestUrl.pathname;
    const method = request.method || "GET";
    const cors = corsHeaders(request);

    if (method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }

    if (method === "GET" && pathname === "/api/health") {
      await store.ping();
      sendJson(response, 200, { status: "ok", service: "visionowl-cloud", store: config.store }, cors);
      return;
    }

    if (method === "POST" && pathname === "/api/auth/register") {
      const body = await readJson(request);
      const email = normalizeEmail(body.email);
      const displayName = requiredText(body.displayName, "display_name", 120);
      const password = String(body.password || "");
      assert(password.length >= 10 && password.length <= 256, 400, "password_invalid", "Password must contain at least 10 characters.");
      const createdAt = nowIso(clock);
      const user = await store.createUser({
        id: randomUUID(),
        email,
        displayName,
        passwordHash: await hashPassword(password),
        status: "active",
        createdAt,
        updatedAt: createdAt,
      });
      sendJson(response, 201, await createSessionBundle(user), cors);
      return;
    }

    if (method === "POST" && pathname === "/api/auth/login") {
      const body = await readJson(request);
      const email = normalizeEmail(body.email);
      const user = await store.userByEmail(email);
      assert(
        user?.status === "active" && (await verifyPassword(String(body.password || ""), user.passwordHash)),
        401,
        "credentials_invalid",
        "Email or password is incorrect.",
      );
      sendJson(response, 200, await createSessionBundle(user), cors);
      return;
    }

    if (method === "POST" && pathname === "/api/auth/refresh") {
      const body = await readJson(request);
      const refreshToken = requiredText(body.refreshToken, "refresh_token", 512);
      const current = await store.sessionByRefreshHash(tokenHash(refreshToken));
      assert(
        current && !current.revokedAt && Date.parse(current.refreshExpiresAt) > clock().getTime(),
        401,
        "refresh_expired",
        "Refresh token is invalid or expired.",
      );
      const accessToken = randomToken();
      const nextRefreshToken = randomToken();
      const updatedAt = nowIso(clock);
      const session = await store.rotateSession(current.id, {
        accessTokenHash: tokenHash(accessToken),
        refreshTokenHash: tokenHash(nextRefreshToken),
        accessExpiresAt: plusSeconds(clock, config.accessTokenTtlSeconds),
        refreshExpiresAt: plusSeconds(clock, config.refreshTokenTtlSeconds),
        updatedAt,
      });
      const user = await store.userById(current.userId);
      sendJson(response, 200, {
        user: publicUser(user),
        accessToken,
        refreshToken: nextRefreshToken,
        accessExpiresAt: session.accessExpiresAt,
        refreshExpiresAt: session.refreshExpiresAt,
      }, cors);
      return;
    }

    if (method === "POST" && pathname === "/api/auth/logout") {
      const auth = await authenticate(request);
      await store.revokeSession(auth.session.id, nowIso(clock));
      sendJson(response, 200, { status: "signed_out" }, cors);
      return;
    }

    if (method === "GET" && pathname === "/api/auth/me") {
      const auth = await authenticate(request);
      sendJson(response, 200, publicUser(auth.user), cors);
      return;
    }

    if (method === "POST" && pathname === "/api/invites/redeem") {
      const auth = await authenticate(request);
      const body = await readJson(request);
      const token = requiredText(body.token, "invite_token", 512);
      const result = await store.redeemInvite(tokenHash(token), auth.user.id, nowIso(clock));
      await audit({
        projectId: result.project.id,
        actorId: auth.user.id,
        action: "invite.redeemed",
        targetType: "project",
        targetId: result.project.id,
        metadata: { role: result.member.role },
      });
      await emit(result.project.id, "project.member.joined", {
        userId: auth.user.id,
        displayName: auth.user.displayName,
        role: result.member.role,
      }, auth.user.id);
      sendJson(response, 200, { project: { ...result.project, role: result.member.role }, membership: result.member }, cors);
      return;
    }

    if (method === "GET" && pathname === "/api/projects") {
      const auth = await authenticate(request);
      sendJson(response, 200, await store.listProjects(auth.user.id), cors);
      return;
    }

    if (method === "POST" && pathname === "/api/projects") {
      const auth = await authenticate(request);
      const body = await readJson(request);
      const createdAt = nowIso(clock);
      const newProjectId = randomUUID();
      const project = await store.createProject(
        {
          id: newProjectId,
          ownerId: auth.user.id,
          name: requiredText(body.name, "project_name", 160),
          description: optionalText(body.description),
          repositoryFingerprint: optionalText(body.repositoryFingerprint, 240) || undefined,
          defaultBranch: optionalText(body.defaultBranch, 120) || "master",
          currentGraphVersionId: undefined,
          createdAt,
          updatedAt: createdAt,
        },
        {
          projectId: newProjectId,
          userId: auth.user.id,
          role: "owner",
          joinedAt: createdAt,
          updatedAt: createdAt,
        },
      );
      await audit({ projectId: project.id, actorId: auth.user.id, action: "project.created", targetType: "project", targetId: project.id });
      sendJson(response, 201, project, cors);
      return;
    }

    let params = matchPath(pathname, "/api/projects/:projectId");
    if (method === "GET" && params) {
      const auth = await authorize(request, params.projectId);
      sendJson(response, 200, { ...auth.project, role: auth.membership.role }, cors);
      return;
    }

    params = matchPath(pathname, "/api/projects/:projectId/members");
    if (method === "GET" && params) {
      await authorize(request, params.projectId);
      sendJson(response, 200, await store.listMembers(params.projectId), cors);
      return;
    }

    params = matchPath(pathname, "/api/projects/:projectId/members/:userId");
    if (method === "PATCH" && params) {
      const auth = await authorize(request, params.projectId, "owner");
      assert(params.userId !== auth.project.ownerId, 409, "owner_immutable", "Project owner role cannot be changed.");
      const body = await readJson(request);
      assert(body.role === "editor" || body.role === "viewer", 400, "role_invalid", "Role must be editor or viewer.");
      const updated = await store.setMemberRole(params.projectId, params.userId, body.role, nowIso(clock));
      assert(updated, 404, "member_not_found", "Project member not found.");
      await audit({ projectId: params.projectId, actorId: auth.user.id, action: "member.role.updated", targetType: "member", targetId: params.userId, metadata: { role: body.role } });
      await emit(params.projectId, "project.member.updated", { userId: params.userId, role: body.role }, auth.user.id);
      sendJson(response, 200, updated, cors);
      return;
    }
    if (method === "DELETE" && params) {
      const auth = await authorize(request, params.projectId, "owner");
      assert(params.userId !== auth.project.ownerId, 409, "owner_immutable", "Project owner cannot be removed.");
      assert(await store.removeMember(params.projectId, params.userId), 404, "member_not_found", "Project member not found.");
      await audit({ projectId: params.projectId, actorId: auth.user.id, action: "member.removed", targetType: "member", targetId: params.userId });
      await emit(params.projectId, "project.member.removed", { userId: params.userId }, auth.user.id);
      sendJson(response, 200, { removed: true }, cors);
      return;
    }

    params = matchPath(pathname, "/api/projects/:projectId/invites");
    if (method === "GET" && params) {
      await authorize(request, params.projectId, "owner");
      const invites = await store.listInvites(params.projectId);
      sendJson(response, 200, invites.map((invite) => publicInvite(invite)), cors);
      return;
    }
    if (method === "POST" && params) {
      const auth = await authorize(request, params.projectId, "owner");
      const body = await readJson(request);
      const role = body.role || "viewer";
      assert(validRole(role) && role !== "owner", 400, "role_invalid", "Invite role must be editor or viewer.");
      const maxUses = Number(body.maxUses || 1);
      assert(Number.isInteger(maxUses) && maxUses > 0 && maxUses <= 100, 400, "max_uses_invalid", "maxUses must be between 1 and 100.");
      const token = `vwo_${randomToken(24)}`;
      const createdAt = nowIso(clock);
      const invite = await store.createInvite({
        id: randomUUID(),
        projectId: params.projectId,
        tokenHash: tokenHash(token),
        role,
        maxUses,
        useCount: 0,
        expiresAt: body.expiresAt || plusSeconds(clock, config.inviteTtlSeconds),
        createdBy: auth.user.id,
        createdAt,
      });
      await audit({ projectId: params.projectId, actorId: auth.user.id, action: "invite.created", targetType: "invite", targetId: invite.id, metadata: { role, maxUses } });
      sendJson(response, 201, publicInvite(invite, token), cors);
      return;
    }

    params = matchPath(pathname, "/api/projects/:projectId/invites/:inviteId");
    if (method === "DELETE" && params) {
      const auth = await authorize(request, params.projectId, "owner");
      const invite = await store.revokeInvite(params.projectId, params.inviteId, nowIso(clock));
      assert(invite, 404, "invite_not_found", "Invitation not found.");
      await audit({ projectId: params.projectId, actorId: auth.user.id, action: "invite.revoked", targetType: "invite", targetId: params.inviteId });
      sendJson(response, 200, publicInvite(invite), cors);
      return;
    }

    params = matchPath(pathname, "/api/projects/:projectId/graph-versions");
    if (method === "GET" && params) {
      await authorize(request, params.projectId);
      const versions = await store.listGraphVersions(params.projectId);
      sendJson(response, 200, versions.map((version) => publicGraphVersion(version)), cors);
      return;
    }
    if (method === "POST" && params) {
      const auth = await authorize(request, params.projectId, "owner");
      const body = await readJson(request, config.graphMaxBytes + 64_000);
      const artifact = body.artifact || body;
      validateSanitizedGraphArtifact(artifact, { projectId: params.projectId, maxBytes: config.graphMaxBytes });
      assert(
        artifact.source.branch === auth.project.defaultBranch || body.sharedDraft === true,
        409,
        "branch_mismatch",
        `Graph branch must be ${auth.project.defaultBranch}.`,
      );
      assert(COMMIT_PATTERN.test(artifact.source.commit), 422, "commit_invalid", "Graph source commit must be a Git commit SHA.");
      const createdAt = nowIso(clock);
      const version = await store.createGraphVersion({
        id: randomUUID(),
        projectId: params.projectId,
        parentVersionId: auth.project.currentGraphVersionId,
        source: body.sharedDraft === true ? "shared-draft" : "local-agent",
        branch: artifact.source.branch,
        commit: artifact.source.commit,
        status: "ready",
        checksum: checksum(artifact),
        artifact,
        engineVersion: optionalText(body.engineVersion, 120) || undefined,
        skillVersion: optionalText(body.skillVersion, 120) || undefined,
        createdBy: auth.user.id,
        createdAt,
      });
      await audit({ projectId: params.projectId, actorId: auth.user.id, action: "graph.version.created", targetType: "graph_version", targetId: version.id, metadata: { branch: version.branch, commit: version.commit, checksum: version.checksum } });
      await emit(params.projectId, "graph.version.ready", { graphVersionId: version.id, branch: version.branch, commit: version.commit }, auth.user.id);
      sendJson(response, 201, publicGraphVersion(version), cors);
      return;
    }

    params = matchPath(pathname, "/api/projects/:projectId/graph-versions/:versionId");
    if (method === "GET" && params) {
      await authorize(request, params.projectId);
      const version = await store.graphVersion(params.projectId, params.versionId);
      assert(version, 404, "graph_version_not_found", "Graph version not found.");
      sendJson(response, 200, publicGraphVersion(version, true), cors);
      return;
    }

    params = matchPath(pathname, "/api/projects/:projectId/graph-versions/:versionId/activate");
    if (method === "POST" && params) {
      const auth = await authorize(request, params.projectId, "owner");
      const result = await store.activateGraphVersion(params.projectId, params.versionId, nowIso(clock));
      assert(result, 404, "graph_version_not_found", "Graph version not found.");
      await audit({ projectId: params.projectId, actorId: auth.user.id, action: "graph.version.activated", targetType: "graph_version", targetId: params.versionId, metadata: { commit: result.version.commit } });
      await emit(params.projectId, "graph.version.activated", { graphVersionId: result.version.id, branch: result.version.branch, commit: result.version.commit }, auth.user.id);
      sendJson(response, 200, publicGraphVersion(result.version), cors);
      return;
    }

    params = matchPath(pathname, "/api/projects/:projectId/graph/current");
    if (method === "GET" && params) {
      await authorize(request, params.projectId);
      const version = await store.currentGraph(params.projectId);
      sendJson(response, 200, version ? publicGraphVersion(version, true) : null, cors);
      return;
    }

    params = matchPath(pathname, "/api/projects/:projectId/documents");
    if (method === "GET" && params) {
      await authorize(request, params.projectId);
      sendJson(response, 200, (await store.listDocuments(params.projectId)).map(publicDocument), cors);
      return;
    }
    if (method === "POST" && params) {
      const auth = await authorize(request, params.projectId, "editor");
      const body = await readJson(request);
      const scope = body.scope === "global" ? "global" : "module";
      const stableEntityId = scope === "module" ? requiredText(body.stableEntityId, "stable_entity_id", 240) : undefined;
      const url = requiredText(body.url, "document_url", 2000);
      assert(validUrl(url), 400, "document_url_invalid", "Document URL must use HTTP or HTTPS.");
      const provider = ["link", "dingtalk", "local"].includes(body.provider) ? body.provider : "link";
      const createdAt = nowIso(clock);
      const document = await store.createDocument({
        id: randomUUID(),
        projectId: params.projectId,
        stableEntityId,
        scope,
        provider,
        externalId: optionalText(body.externalId, 240) || undefined,
        title: requiredText(body.title, "document_title", 240),
        url,
        summary: optionalText(body.summary),
        syncStatus: "linked",
        version: 1,
        createdBy: auth.user.id,
        createdAt,
        updatedAt: createdAt,
      });
      await audit({ projectId: params.projectId, actorId: auth.user.id, action: "document.created", targetType: "document", targetId: document.id, metadata: { scope, stableEntityId } });
      await emit(params.projectId, "document.created", { document: publicDocument(document) }, auth.user.id);
      sendJson(response, 201, publicDocument(document), cors);
      return;
    }

    params = matchPath(pathname, "/api/projects/:projectId/documents/:documentId");
    if (method === "PATCH" && params) {
      const auth = await authorize(request, params.projectId, "editor");
      const body = await readJson(request);
      if (body.url !== undefined) assert(validUrl(body.url), 400, "document_url_invalid", "Document URL must use HTTP or HTTPS.");
      const updated = await store.updateDocument(params.projectId, params.documentId, {
        ...(body.title !== undefined ? { title: requiredText(body.title, "document_title", 240) } : {}),
        ...(body.url !== undefined ? { url: body.url } : {}),
        ...(body.summary !== undefined ? { summary: optionalText(body.summary) } : {}),
        ...(body.syncStatus !== undefined && ["linked", "synced", "stale", "error"].includes(body.syncStatus) ? { syncStatus: body.syncStatus } : {}),
        updatedAt: nowIso(clock),
      });
      assert(updated, 404, "document_not_found", "Document not found.");
      await emit(params.projectId, "document.updated", { document: publicDocument(updated) }, auth.user.id);
      sendJson(response, 200, publicDocument(updated), cors);
      return;
    }
    if (method === "DELETE" && params) {
      const auth = await authorize(request, params.projectId, "editor");
      assert(await store.deleteDocument(params.projectId, params.documentId), 404, "document_not_found", "Document not found.");
      await audit({ projectId: params.projectId, actorId: auth.user.id, action: "document.deleted", targetType: "document", targetId: params.documentId });
      await emit(params.projectId, "document.deleted", { documentId: params.documentId }, auth.user.id);
      sendJson(response, 200, { removed: true }, cors);
      return;
    }

    params = matchPath(pathname, "/api/projects/:projectId/annotations");
    if (method === "GET" && params) {
      await authorize(request, params.projectId);
      const entityId = requestUrl.searchParams.get("entityId") || undefined;
      sendJson(response, 200, (await store.listAnnotations(params.projectId, entityId)).map(publicAnnotation), cors);
      return;
    }
    if (method === "POST" && params) {
      const auth = await authorize(request, params.projectId, "editor");
      const body = await readJson(request);
      const createdAt = nowIso(clock);
      const annotation = await store.createAnnotation({
        id: randomUUID(),
        projectId: params.projectId,
        stableEntityId: requiredText(body.stableEntityId, "stable_entity_id", 240),
        body: requiredText(body.body, "annotation_body", 4000),
        version: 1,
        createdBy: auth.user.id,
        author: auth.user.displayName,
        createdAt,
        updatedAt: createdAt,
      });
      await emit(params.projectId, "annotation.created", { annotation: publicAnnotation(annotation) }, auth.user.id);
      sendJson(response, 201, publicAnnotation(annotation), cors);
      return;
    }

    params = matchPath(pathname, "/api/projects/:projectId/annotations/:annotationId");
    if (method === "PATCH" && params) {
      const auth = await authorize(request, params.projectId, "editor");
      const body = await readJson(request);
      const updated = await store.updateAnnotation(
        params.projectId,
        params.annotationId,
        auth.user.id,
        { body: requiredText(body.body, "annotation_body", 4000), updatedAt: nowIso(clock) },
        body.version ? Number(body.version) : undefined,
        auth.membership.role === "owner",
      );
      assert(updated, 404, "annotation_not_found", "Annotation not found.");
      await emit(params.projectId, "annotation.updated", { annotation: publicAnnotation(updated) }, auth.user.id);
      sendJson(response, 200, publicAnnotation(updated), cors);
      return;
    }
    if (method === "DELETE" && params) {
      const auth = await authorize(request, params.projectId, "editor");
      const deleted = await store.deleteAnnotation(
        params.projectId,
        params.annotationId,
        auth.user.id,
        nowIso(clock),
        auth.membership.role === "owner",
      );
      assert(deleted, 404, "annotation_not_found", "Annotation not found.");
      await emit(params.projectId, "annotation.deleted", { annotationId: params.annotationId }, auth.user.id);
      sendJson(response, 200, { removed: true }, cors);
      return;
    }

    params = matchPath(pathname, "/api/projects/:projectId/events");
    if (method === "GET" && params) {
      await authorize(request, params.projectId);
      const after = Math.max(0, Number(requestUrl.searchParams.get("after") || 0));
      sendJson(response, 200, await store.eventsAfter(params.projectId, after), cors);
      return;
    }

    params = matchPath(pathname, "/api/projects/:projectId/realtime-ticket");
    if (method === "POST" && params) {
      const auth = await authorize(request, params.projectId);
      const token = randomToken(24);
      await store.createRealtimeTicket({
        tokenHash: tokenHash(token),
        projectId: params.projectId,
        userId: auth.user.id,
        expiresAt: plusSeconds(clock, 60),
        createdAt: nowIso(clock),
      });
      sendJson(response, 201, { ticket: token, expiresInSeconds: 60 }, cors);
      return;
    }

    throw new CloudError(404, "route_not_found", "Route not found.");
  }

  const server = http.createServer((request, response) => {
    route(request, response).catch((error) => {
      const status = error.status || 500;
      if (status >= 500) logger.error(error);
      try {
        const cors = (() => {
          try {
            return corsHeaders(request);
          } catch (_ignored) {
            return {};
          }
        })();
        sendJson(response, status, {
          error: error.code || "internal_error",
          message: status >= 500 ? "Cloud service failed to process the request." : error.message,
          ...(error.details ? { details: error.details } : {}),
        }, cors);
      } catch (writeError) {
        logger.error(writeError);
        response.destroy();
      }
    });
  });

  server.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url, "http://visionowl.local");
    const params = matchPath(requestUrl.pathname, "/ws/projects/:projectId");
    const origin = request.headers.origin;
    if (!params || (origin && !config.allowedOrigins.includes(origin))) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const ticket = requestUrl.searchParams.get("ticket") || "";
    const after = Math.max(0, Number(requestUrl.searchParams.get("after") || 0));
    store
      .consumeRealtimeTicket(tokenHash(ticket), nowIso(clock))
      .then(async (value) => {
        if (!value || value.projectId !== params.projectId) {
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        const membership = await store.member(params.projectId, value.userId);
        if (!membership) {
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        websocketServer.handleUpgrade(request, socket, head, async (websocket) => {
          hub.subscribe(params.projectId, websocket);
          websocket.send(JSON.stringify({ event: "connected", data: { projectId: params.projectId, role: membership.role } }));
          const events = await store.eventsAfter(params.projectId, after);
          for (const event of events) {
            if (websocket.readyState === 1) {
              websocket.send(JSON.stringify({ event: "project.event", data: event }));
            }
          }
        });
      })
      .catch((error) => {
        logger.error(error);
        socket.destroy();
      });
  });

  return {
    server,
    async close() {
      hub.close();
      websocketServer.close();
      await new Promise((resolve) => server.close(resolve));
      await store.close();
    },
  };
}

module.exports = { createCloudApp };
