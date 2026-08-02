import type {
  AnalysisEvent,
  AnalysisJob,
  Annotation,
  ChatCompletion,
  ChatProgress,
  DocumentGenerationCompletion,
  DocumentGenerationProgress,
  DocumentRefreshCompletion,
  DocumentRefreshProgress,
  DocumentBinding,
  EntityContext,
  EntityScope,
  GraphVersion,
  Project,
  ProjectAutomationSettings,
} from "@visionowl/contracts";

const API_BASE = (import.meta.env.VITE_VISIONOWL_API_URL || "").replace(/\/$/, "");

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || payload.error || `Request failed: ${response.status}`);
  }
  return payload as T;
}

async function streamChat(
  projectId: string,
  input: {
    entityId: string;
    question: string;
    conversationId?: string;
    scope?: EntityScope;
  },
  onProgress: (progress: ChatProgress) => void,
) {
  const response = await fetch(
    `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/chat/stream`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(
      payload.message || payload.error || `Request failed: ${response.status}`,
    );
  }
  if (!response.body) throw new Error("Streaming response body is unavailable.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completion: ChatCompletion | undefined;

  const consumeFrame = (frame: string) => {
    let event = "message";
    const data = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) return;
    const payload = JSON.parse(data.join("\n"));
    if (event === "progress") onProgress(payload as ChatProgress);
    if (event === "complete") completion = payload as ChatCompletion;
    if (event === "error") {
      throw new Error(payload.message || "Codex stream failed.");
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replaceAll("\r\n", "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      consumeFrame(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  if (buffer.trim()) consumeFrame(buffer);
  if (!completion) throw new Error("Codex stream ended without a final answer.");
  return completion;
}

async function streamDocumentGeneration(
  projectId: string,
  entityId: string,
  input: { scope?: EntityScope },
  onProgress: (progress: DocumentGenerationProgress) => void,
) {
  const response = await fetch(
    `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/entities/${encodeURIComponent(entityId)}/documents/generate/stream`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(
      payload.message || payload.error || `Request failed: ${response.status}`,
    );
  }
  if (!response.body) throw new Error("Streaming response body is unavailable.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completion: DocumentGenerationCompletion | undefined;
  const consumeFrame = (frame: string) => {
    let event = "message";
    const data = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) return;
    const payload = JSON.parse(data.join("\n"));
    if (event === "progress") onProgress(payload as DocumentGenerationProgress);
    if (event === "complete") completion = payload as DocumentGenerationCompletion;
    if (event === "error") throw new Error(payload.message || "Document generation failed.");
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replaceAll("\r\n", "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      consumeFrame(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  if (buffer.trim()) consumeFrame(buffer);
  if (!completion) throw new Error("Document generation ended without a result.");
  return completion;
}

async function streamDocumentRefresh(
  projectId: string,
  entityId: string,
  input: { scope?: EntityScope },
  onProgress: (progress: DocumentRefreshProgress) => void,
) {
  const response = await fetch(
    `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/entities/${encodeURIComponent(entityId)}/documents/refresh/stream`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(
      payload.message || payload.error || `Request failed: ${response.status}`,
    );
  }
  if (!response.body) throw new Error("Streaming response body is unavailable.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completion: DocumentRefreshCompletion | undefined;
  const consumeFrame = (frame: string) => {
    let event = "message";
    const data = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) return;
    const payload = JSON.parse(data.join("\n"));
    if (event === "progress") onProgress(payload as DocumentRefreshProgress);
    if (event === "complete") completion = payload as DocumentRefreshCompletion;
    if (event === "error") throw new Error(payload.message || "Document refresh failed.");
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replaceAll("\r\n", "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      consumeFrame(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  if (buffer.trim()) consumeFrame(buffer);
  if (!completion) throw new Error("Document refresh ended without a result.");
  return completion;
}

export const visionApi = {
  listProjects: () => request<Project[]>("/api/projects"),
  createProject: (input: { name: string; description?: string; repoPath: string }) =>
    request<Project>("/api/projects", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getGraph: (projectId: string) =>
    request<GraphVersion>(`/api/projects/${encodeURIComponent(projectId)}/graph`),
  listJobs: (projectId: string) =>
    request<AnalysisJob[]>(`/api/projects/${encodeURIComponent(projectId)}/jobs`),
  getAutomation: (projectId: string) =>
    request<ProjectAutomationSettings>(
      `/api/projects/${encodeURIComponent(projectId)}/automation`,
    ),
  setDebugMode: (projectId: string, debugMode: boolean) =>
    request<ProjectAutomationSettings>(
      `/api/projects/${encodeURIComponent(projectId)}/automation`,
      {
        method: "PATCH",
        body: JSON.stringify({ debugMode }),
      },
    ),
  analyze: (projectId: string, useCodex: boolean) =>
    request<AnalysisJob>(`/api/projects/${encodeURIComponent(projectId)}/analyze`, {
      method: "POST",
      body: JSON.stringify({ useCodex }),
    }),
  getEntity: (projectId: string, entityId: string) =>
    request<EntityContext>(
      `/api/projects/${encodeURIComponent(projectId)}/entities/${encodeURIComponent(entityId)}`,
    ),
  getScope: (projectId: string, scope: EntityScope) =>
    request<EntityContext>(
      `/api/projects/${encodeURIComponent(projectId)}/scopes/context`,
      {
        method: "POST",
        body: JSON.stringify(scope),
      },
    ),
  listDocuments: (projectId: string) =>
    request<DocumentBinding[]>(
      `/api/projects/${encodeURIComponent(projectId)}/documents`,
    ),
  addProjectDocument: (
    projectId: string,
    input: {
      provider: "link" | "dingtalk" | "local";
      title: string;
      url: string;
      summary?: string;
    },
  ) =>
    request<DocumentBinding>(
      `/api/projects/${encodeURIComponent(projectId)}/documents`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  addAnnotation: (
    projectId: string,
    entityId: string,
    input: { author: string; body: string },
  ) =>
    request<Annotation>(
      `/api/projects/${encodeURIComponent(projectId)}/entities/${encodeURIComponent(entityId)}/annotations`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  addDocument: (
    projectId: string,
    entityId: string,
    input: {
      provider: "link" | "dingtalk" | "local";
      title: string;
      url: string;
      summary?: string;
    },
  ) =>
    request<DocumentBinding>(
      `/api/projects/${encodeURIComponent(projectId)}/entities/${encodeURIComponent(entityId)}/documents`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  chat: (
    projectId: string,
    input: {
      entityId: string;
      question: string;
      conversationId?: string;
      scope?: EntityScope;
    },
  ) =>
    request<{
      conversationId: string;
      message: {
        id: string;
        role: "assistant";
        content: string;
        provider: "codex" | "local-fallback";
      };
    }>(`/api/projects/${encodeURIComponent(projectId)}/chat`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  chatStream: streamChat,
  generateDocumentStream: streamDocumentGeneration,
  refreshDocumentsStream: streamDocumentRefresh,
  events: (projectId: string) =>
    new EventSource(
      `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/events`,
    ),
};

export type { AnalysisEvent };
