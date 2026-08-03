import type {
  CloudAnnotation,
  CloudDocument,
  CloudGraphVersion,
  CloudProject,
  CloudProjectInvite,
  CloudProjectMember,
  CloudRealtimeEvent,
  CloudRole,
  CloudSession,
  SanitizedGraphArtifact,
} from "@visionowl/contracts";
import {
  clearCloudSession,
  cloudApiBase,
  loadCloudSession,
  saveCloudSession,
} from "./session-store";

export class CloudApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CloudApiError";
    this.status = status;
    this.code = code;
  }
}

async function rawRequest<T>(
  path: string,
  options: RequestInit = {},
  token?: string,
): Promise<T> {
  const response = await fetch(`${await cloudApiBase()}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new CloudApiError(
      response.status,
      payload?.error || "cloud_request_failed",
      payload?.message || `Cloud request failed: ${response.status}`,
    );
  }
  return payload as T;
}

let refreshInFlight: Promise<CloudSession> | undefined;

async function refreshSession(session: CloudSession) {
  refreshInFlight ||= rawRequest<CloudSession>("/api/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  })
    .then(async (next) => {
      await saveCloudSession(next);
      return next;
    })
    .finally(() => {
      refreshInFlight = undefined;
    });
  return refreshInFlight;
}

async function authenticatedRequest<T>(path: string, options?: RequestInit) {
  let session = await loadCloudSession();
  if (!session) throw new CloudApiError(401, "authentication_required", "请先登录云端协作空间。");
  if (Date.parse(session.accessExpiresAt) - Date.now() < 30_000) {
    session = await refreshSession(session);
  }
  try {
    return await rawRequest<T>(path, options, session.accessToken);
  } catch (error) {
    if (!(error instanceof CloudApiError) || error.status !== 401) throw error;
    try {
      session = await refreshSession(session);
      return await rawRequest<T>(path, options, session.accessToken);
    } catch (refreshError) {
      await clearCloudSession();
      throw refreshError;
    }
  }
}

export const cloudApi = {
  health: () => rawRequest<{ status: string; service: string }>("/api/health"),
  register: async (input: { email: string; displayName: string; password: string }) => {
    const session = await rawRequest<CloudSession>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(input),
    });
    await saveCloudSession(session);
    return session;
  },
  login: async (input: { email: string; password: string }) => {
    const session = await rawRequest<CloudSession>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(input),
    });
    await saveCloudSession(session);
    return session;
  },
  logout: async () => {
    try {
      await authenticatedRequest("/api/auth/logout", { method: "POST" });
    } finally {
      await clearCloudSession();
    }
  },
  session: loadCloudSession,
  listProjects: () => authenticatedRequest<CloudProject[]>("/api/projects"),
  createProject: (input: {
    name: string;
    description?: string;
    defaultBranch?: string;
    repositoryFingerprint?: string;
  }) =>
    authenticatedRequest<CloudProject>("/api/projects", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  redeemInvite: (token: string) =>
    authenticatedRequest<{ project: CloudProject }>("/api/invites/redeem", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  listMembers: (projectId: string) =>
    authenticatedRequest<CloudProjectMember[]>(
      `/api/projects/${encodeURIComponent(projectId)}/members`,
    ),
  updateMember: (projectId: string, userId: string, role: Exclude<CloudRole, "owner">) =>
    authenticatedRequest<CloudProjectMember>(
      `/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
      { method: "PATCH", body: JSON.stringify({ role }) },
    ),
  removeMember: (projectId: string, userId: string) =>
    authenticatedRequest<{ removed: boolean }>(
      `/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
    ),
  createInvite: (projectId: string, input: { role: "editor" | "viewer"; maxUses?: number }) =>
    authenticatedRequest<CloudProjectInvite>(
      `/api/projects/${encodeURIComponent(projectId)}/invites`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  listInvites: (projectId: string) =>
    authenticatedRequest<CloudProjectInvite[]>(
      `/api/projects/${encodeURIComponent(projectId)}/invites`,
    ),
  revokeInvite: (projectId: string, inviteId: string) =>
    authenticatedRequest<CloudProjectInvite>(
      `/api/projects/${encodeURIComponent(projectId)}/invites/${encodeURIComponent(inviteId)}`,
      { method: "DELETE" },
    ),
  listGraphVersions: (projectId: string) =>
    authenticatedRequest<CloudGraphVersion[]>(
      `/api/projects/${encodeURIComponent(projectId)}/graph-versions`,
    ),
  currentGraph: (projectId: string) =>
    authenticatedRequest<CloudGraphVersion | null>(
      `/api/projects/${encodeURIComponent(projectId)}/graph/current`,
    ),
  uploadGraph: (
    projectId: string,
    artifact: SanitizedGraphArtifact,
    input: { engineVersion?: string; skillVersion?: string; sharedDraft?: boolean } = {},
  ) =>
    authenticatedRequest<CloudGraphVersion>(
      `/api/projects/${encodeURIComponent(projectId)}/graph-versions`,
      {
        method: "POST",
        body: JSON.stringify({ artifact, ...input }),
      },
    ),
  activateGraph: (projectId: string, versionId: string) =>
    authenticatedRequest<CloudGraphVersion>(
      `/api/projects/${encodeURIComponent(projectId)}/graph-versions/${encodeURIComponent(versionId)}/activate`,
      { method: "POST", body: "{}" },
    ),
  listDocuments: (projectId: string) =>
    authenticatedRequest<CloudDocument[]>(
      `/api/projects/${encodeURIComponent(projectId)}/documents`,
    ),
  createDocument: (
    projectId: string,
    input: {
      scope: "global" | "module";
      stableEntityId?: string;
      provider: "link" | "dingtalk" | "local";
      title: string;
      url: string;
      summary?: string;
    },
  ) =>
    authenticatedRequest<CloudDocument>(
      `/api/projects/${encodeURIComponent(projectId)}/documents`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  updateDocument: (
    projectId: string,
    documentId: string,
    input: Partial<Pick<CloudDocument, "title" | "url" | "summary" | "syncStatus">>,
  ) =>
    authenticatedRequest<CloudDocument>(
      `/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}`,
      { method: "PATCH", body: JSON.stringify(input) },
    ),
  deleteDocument: (projectId: string, documentId: string) =>
    authenticatedRequest<{ removed: boolean }>(
      `/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}`,
      { method: "DELETE" },
    ),
  listAnnotations: (projectId: string, entityId?: string) =>
    authenticatedRequest<CloudAnnotation[]>(
      `/api/projects/${encodeURIComponent(projectId)}/annotations${
        entityId ? `?entityId=${encodeURIComponent(entityId)}` : ""
      }`,
    ),
  createAnnotation: (projectId: string, stableEntityId: string, body: string) =>
    authenticatedRequest<CloudAnnotation>(
      `/api/projects/${encodeURIComponent(projectId)}/annotations`,
      {
        method: "POST",
        body: JSON.stringify({ stableEntityId, body }),
      },
    ),
  updateAnnotation: (
    projectId: string,
    annotationId: string,
    body: string,
    expectedVersion: number,
  ) =>
    authenticatedRequest<CloudAnnotation>(
      `/api/projects/${encodeURIComponent(projectId)}/annotations/${encodeURIComponent(annotationId)}`,
      { method: "PATCH", body: JSON.stringify({ body, expectedVersion }) },
    ),
  deleteAnnotation: (projectId: string, annotationId: string) =>
    authenticatedRequest<{ removed: boolean }>(
      `/api/projects/${encodeURIComponent(projectId)}/annotations/${encodeURIComponent(annotationId)}`,
      { method: "DELETE" },
    ),
  events: (projectId: string, after = 0) =>
    authenticatedRequest<CloudRealtimeEvent[]>(
      `/api/projects/${encodeURIComponent(projectId)}/events?after=${after}`,
    ),
  realtimeTicket: (projectId: string) =>
    authenticatedRequest<{ ticket: string; expiresInSeconds: number }>(
      `/api/projects/${encodeURIComponent(projectId)}/realtime-ticket`,
      { method: "POST", body: "{}" },
    ),
};
