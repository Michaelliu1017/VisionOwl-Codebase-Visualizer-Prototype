/**
 * 统一 API 客户端。
 * 默认连接真实 Cloud Backend。只有显式设置 VITE_USE_MOCK=1 时才走本地 mock。
 * 使用 mock: npm run dev:mock
 */
import type {
  Annotation, ApiError, AuthResult, BindRepoInput, ChatEvent, DingtalkAuthTask,
  DingtalkConnection, DocumentLink, DocgenPublication, DocgenTask, GeneratedDocumentContent, GraphArtifact, GraphVersion, InvitationCreated,
  InvitationRedeemed, Job, KnowledgeAssetSummary, KnowledgeRun, Project, ProjectEvent, ProjectSummary,
  PublicBranch, PublicRepository, RepositoryBinding
} from './types'
import { mockApi } from '../mock'
import { normalizeGraphArtifact } from '../graph/normalize'

const USE_MOCK = import.meta.env.VITE_USE_MOCK === '1'
const API_BASE: string = import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:8080'

let authToken: string | null = null
export function setToken(token: string | null): void {
  authToken = token
}

export const isMockApi = USE_MOCK

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined && init.body !== null
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      'X-Client-Version': '0.1.0',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...init?.headers
    }
  })
  if (res.status === 204) return undefined as T
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const err = (body as ApiError | null)?.error
    throw Object.assign(new Error(err?.message ?? `HTTP ${res.status}`), {
      code: err?.code ?? 'INTERNAL',
      status: res.status
    })
  }
  return body as T
}

async function authenticatedFetch(path: string): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      'X-Client-Version': '0.1.0',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
    }
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null) as ApiError | null
    throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
  }
  return res
}

/** 解析 SSE 流为 ChatEvent(契约 §6) */
async function* sseChat(path: string, payload: unknown): AsyncGenerator<ChatEvent> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
    },
    body: JSON.stringify(payload)
  })
  if (!res.ok || !res.body) throw new Error(`chat 连接失败: HTTP ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      let event = ''
      let data = ''
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data += line.slice(5).trim()
      }
      if (event && data) {
        yield { type: event, ...JSON.parse(data) } as ChatEvent
      }
    }
  }
}

export function subscribeProjectEvents(
  projectId: string,
  onEvent: (event: ProjectEvent) => void,
  onConnection?: (connected: boolean) => void
): () => void {
  if (USE_MOCK) return () => undefined

  let stopped = false
  let controller: AbortController | null = null
  let lastEventId: number | null = null

  const run = async () => {
    while (!stopped) {
      controller = new AbortController()
      try {
        const res = await fetch(`${API_BASE}/api/projects/${projectId}/events`, {
          headers: {
            Accept: 'text/event-stream',
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
            ...(lastEventId !== null ? { 'Last-Event-ID': String(lastEventId) } : {})
          },
          signal: controller.signal
        })
        if (!res.ok || !res.body) throw new Error(`events 连接失败: HTTP ${res.status}`)
        onConnection?.(true)
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done || stopped) break
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
          let boundary: number
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            let id: number | null = null
            let type = ''
            let data = ''
            for (const line of frame.split('\n')) {
              if (line.startsWith('id:')) id = Number(line.slice(3).trim())
              else if (line.startsWith('event:')) type = line.slice(6).trim()
              else if (line.startsWith('data:')) data += line.slice(5).trim()
            }
            if (id !== null && Number.isFinite(id)) lastEventId = id
            if (id !== null && type && data) {
              onEvent({ id, type, data: JSON.parse(data) } as ProjectEvent)
            }
          }
        }
      } catch (error) {
        if (!stopped && !(error instanceof DOMException && error.name === 'AbortError')) {
          onConnection?.(false)
        }
      }
      if (!stopped) await new Promise(resolve => setTimeout(resolve, 1500))
    }
  }
  void run()
  return () => {
    stopped = true
    controller?.abort()
    onConnection?.(false)
  }
}

export const api = {
  async login(email: string, password: string): Promise<AuthResult> {
    if (USE_MOCK) return mockApi.login(email, password)
    return http<AuthResult>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    })
  },

  async listProjects(): Promise<ProjectSummary[]> {
    if (USE_MOCK) return mockApi.listProjects()
    return (await http<{ items: ProjectSummary[] }>('/api/projects')).items
  },

  async getProject(id: string): Promise<Project> {
    if (USE_MOCK) return mockApi.getProject(id)
    return http<Project>(`/api/projects/${id}`)
  },

  async createProject(name: string): Promise<Project> {
    if (USE_MOCK) return mockApi.createProject(name)
    return http<Project>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name })
    })
  },

  async createInvitation(projectId: string): Promise<InvitationCreated> {
    if (USE_MOCK) return mockApi.createInvitation(projectId)
    return http<InvitationCreated>(`/api/projects/${projectId}/invitations`, {
      method: 'POST',
      body: JSON.stringify({})
    })
  },

  async redeemInvitation(key: string): Promise<InvitationRedeemed> {
    if (USE_MOCK) return mockApi.redeemInvitation(key)
    return http<InvitationRedeemed>('/api/invitations/redeem', {
      method: 'POST',
      body: JSON.stringify({ key })
    })
  },

  async deleteProject(projectId: string): Promise<void> {
    if (USE_MOCK) return mockApi.deleteProject(projectId)
    return http<void>(`/api/projects/${projectId}`, { method: 'DELETE' })
  },

  async bindRepository(projectId: string, input: BindRepoInput): Promise<RepositoryBinding> {
    if (USE_MOCK) return mockApi.bindRepository(projectId, input)
    return http<RepositoryBinding>(`/api/projects/${projectId}/repositories`, {
      method: 'POST',
      body: JSON.stringify(input)
    })
  },

  async listRepositories(projectId: string): Promise<RepositoryBinding[]> {
    if (USE_MOCK) return mockApi.listRepositories(projectId)
    return (await http<{ items: RepositoryBinding[] }>(`/api/projects/${projectId}/repositories`)).items
  },

  async deleteRepository(projectId: string, bindingId: string): Promise<void> {
    if (USE_MOCK) return mockApi.deleteRepository(projectId, bindingId)
    return http<void>(`/api/projects/${projectId}/repositories/${bindingId}`, { method: 'DELETE' })
  },

  async inspectPublicRepository(repo: string): Promise<PublicRepository> {
    if (USE_MOCK) return mockApi.inspectPublicRepository(repo)
    return http<PublicRepository>(`/api/github/public/repository?repo=${encodeURIComponent(repo)}`)
  },

  async listPublicBranches(repo: string): Promise<PublicBranch[]> {
    if (USE_MOCK) return mockApi.listPublicBranches(repo)
    return (await http<{ items: PublicBranch[] }>(`/api/github/public/branches?repo=${encodeURIComponent(repo)}`)).items
  },

  async createJob(projectId: string, input: { force?: boolean } = {}): Promise<Job> {
    if (USE_MOCK) return mockApi.createJob(projectId, input)
    return http<Job>(`/api/projects/${projectId}/jobs`, {
      method: 'POST',
      body: JSON.stringify({ type: 'full', force: input.force ?? false })
    })
  },

  async getJob(jobId: string): Promise<Job> {
    if (USE_MOCK) return mockApi.getJob(jobId)
    return http<Job>(`/api/jobs/${jobId}`)
  },

  async listJobs(projectId: string, limit = 10): Promise<Job[]> {
    if (USE_MOCK) return mockApi.listJobs(projectId, limit)
    return (await http<{ items: Job[] }>(`/api/projects/${projectId}/jobs?limit=${limit}`)).items
  },

  async getGraphCurrent(projectId: string): Promise<GraphVersion> {
    if (USE_MOCK) return mockApi.getGraphCurrent(projectId)
    return http<GraphVersion>(`/api/projects/${projectId}/graph/current`)
  },

  async getGraphVersion(projectId: string, versionNo: number): Promise<GraphVersion> {
    if (USE_MOCK) return mockApi.getGraphCurrent(projectId)
    return http<GraphVersion>(`/api/projects/${projectId}/graph/versions/${versionNo}`)
  },

  /** artifactUrl 是不透明 URL:后端返回什么就 GET 什么 */
  async getGraphArtifact(artifactUrl: string): Promise<GraphArtifact> {
    if (USE_MOCK) return normalizeGraphArtifact(await mockApi.getGraphArtifact(artifactUrl))
    if (artifactUrl.startsWith('http')) {
      const res = await fetch(artifactUrl, {
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined
      })
      if (!res.ok) throw new Error(`图谱下载失败: HTTP ${res.status}`)
      return normalizeGraphArtifact(await res.json() as GraphArtifact)
    }
    return normalizeGraphArtifact(await http<GraphArtifact>(artifactUrl))
  },

  async listDocuments(projectId: string): Promise<DocumentLink[]> {
    if (USE_MOCK) return mockApi.listDocuments(projectId)
    return (await http<{ items: DocumentLink[] }>(`/api/projects/${projectId}/documents`)).items
  },

  async listAnnotations(projectId: string): Promise<Annotation[]> {
    if (USE_MOCK) return mockApi.listAnnotations(projectId)
    return (await http<{ items: Annotation[] }>(`/api/projects/${projectId}/annotations`)).items
  },

  async listKnowledgeAssets(projectId: string): Promise<KnowledgeAssetSummary[]> {
    if (USE_MOCK) return []
    return (await http<{ items: KnowledgeAssetSummary[] }>(
      `/api/projects/${projectId}/knowledge-assets`
    )).items
  },

  async createKnowledgeRun(projectId: string, force = false): Promise<KnowledgeRun> {
    if (USE_MOCK) throw new Error('Mock 模式未连接 Knowledge Generator')
    return http<KnowledgeRun>(`/api/projects/${projectId}/knowledge-runs`, {
      method: 'POST',
      body: JSON.stringify({ requestedAssets: ['wiki', 'skills'], force })
    })
  },

  async getKnowledgeRun(projectId: string, runId: string): Promise<KnowledgeRun> {
    if (USE_MOCK) throw new Error('Mock 模式没有知识生成任务')
    return http<KnowledgeRun>(`/api/projects/${projectId}/knowledge-runs/${runId}`)
  },

  async getKnowledgeAssetContent(
    projectId: string,
    assetId: string,
    path: string
  ): Promise<string> {
    if (USE_MOCK) return '# Mock knowledge asset\n'
    const res = await authenticatedFetch(
      `/api/projects/${projectId}/knowledge-assets/${assetId}/content?path=${encodeURIComponent(path)}`
    )
    return res.text()
  },

  async downloadKnowledgeAsset(
    projectId: string,
    assetId: string,
    fallbackName: string
  ): Promise<{ blob: Blob; fileName: string }> {
    if (USE_MOCK) return { blob: new Blob(['mock']), fileName: fallbackName }
    const res = await authenticatedFetch(
      `/api/projects/${projectId}/knowledge-assets/${assetId}/download`
    )
    const disposition = res.headers.get('content-disposition') ?? ''
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1]
    return {
      blob: await res.blob(),
      fileName: encoded ? decodeURIComponent(encoded) : fallbackName
    }
  },

  async createDocument(
    projectId: string,
    input: { scope: 'global' | 'module'; nodeId: string | null; title: string; url: string; docType: DocumentLink['docType'] }
  ): Promise<DocumentLink> {
    if (USE_MOCK) return mockApi.createDocument(input)
    return http<DocumentLink>(`/api/projects/${projectId}/documents`, {
      method: 'POST',
      body: JSON.stringify(input)
    })
  },

  async deleteDocument(projectId: string, docId: string): Promise<void> {
    if (USE_MOCK) return mockApi.deleteDocument(docId)
    return http<void>(`/api/projects/${projectId}/documents/${docId}`, { method: 'DELETE' })
  },

  async generateDocument(projectId: string, nodeId: string): Promise<DocgenTask> {
    if (USE_MOCK) return mockApi.generateDocument(nodeId)
    const accepted = await http<{ taskId: string; nodeId: string; commitSha: string }>(
      `/api/projects/${projectId}/documents/generate`,
      { method: 'POST', body: JSON.stringify({ nodeId }) }
    )
    return { ...accepted, status: 'pending', docId: null, error: null, credits: null }
  },

  async getDocgenTask(projectId: string, taskId: string): Promise<DocgenTask> {
    if (USE_MOCK) return mockApi.getDocgenTask(taskId)
    return http<DocgenTask>(`/api/projects/${projectId}/docgen/${taskId}`)
  },

  async getDocgenPublication(projectId: string, taskId: string): Promise<DocgenPublication> {
    return http<DocgenPublication>(`/api/projects/${projectId}/docgen/${taskId}/publication`)
  },

  async confirmDocgenPublication(
    projectId: string,
    taskId: string,
    input: { profileKey: string; dingtalkNodeId: string; url: string }
  ): Promise<DocumentLink> {
    return http<DocumentLink>(`/api/projects/${projectId}/docgen/${taskId}/published`, {
      method: 'POST', body: JSON.stringify(input)
    })
  },

  async getGeneratedDocument(projectId: string, docId: string): Promise<GeneratedDocumentContent> {
    if (USE_MOCK) return mockApi.getGeneratedDocument(docId)
    return http<GeneratedDocumentContent>(`/api/projects/${projectId}/documents/${docId}/content`)
  },

  async listDingtalkConnections(): Promise<{ configured: boolean; connections: DingtalkConnection[] }> {
    if (USE_MOCK) return mockApi.listDingtalkConnections()
    return http<{ configured: boolean; connections: DingtalkConnection[] }>(`/api/integrations/dingtalk`)
  },

  async startDingtalkConnection(): Promise<DingtalkAuthTask> {
    if (USE_MOCK) return mockApi.startDingtalkConnection()
    return http<DingtalkAuthTask>(`/api/integrations/dingtalk/connect`, { method: 'POST' })
  },

  async getDingtalkConnectionTask(taskId: string): Promise<DingtalkAuthTask> {
    if (USE_MOCK) return mockApi.getDingtalkConnectionTask(taskId)
    return http<DingtalkAuthTask>(`/api/integrations/dingtalk/connect/${taskId}`)
  },

  async selectDingtalkConnection(connectionId: string): Promise<DingtalkConnection> {
    if (USE_MOCK) return mockApi.selectDingtalkConnection(connectionId)
    return http<DingtalkConnection>(`/api/integrations/dingtalk/${connectionId}/select`, { method: 'POST' })
  },

  async updateDingtalkConnection(
    connectionId: string,
    input: { workspaceId: string | null; folderId: string | null }
  ): Promise<DingtalkConnection> {
    if (USE_MOCK) return mockApi.updateDingtalkConnection(connectionId, input)
    return http<DingtalkConnection>(`/api/integrations/dingtalk/${connectionId}`, {
      method: 'PATCH', body: JSON.stringify(input)
    })
  },

  async deleteDingtalkConnection(connectionId: string): Promise<void> {
    if (USE_MOCK) return mockApi.deleteDingtalkConnection(connectionId)
    return http<void>(`/api/integrations/dingtalk/${connectionId}`, { method: 'DELETE' })
  },

  async createAnnotation(
    projectId: string,
    input: { targetKind: 'node' | 'edge'; targetId: string; body: string }
  ): Promise<Annotation> {
    if (USE_MOCK) return mockApi.createAnnotation(input)
    return http<Annotation>(`/api/projects/${projectId}/annotations`, {
      method: 'POST',
      body: JSON.stringify(input)
    })
  },

  async deleteAnnotation(projectId: string, annId: string): Promise<void> {
    if (USE_MOCK) return mockApi.deleteAnnotation(annId)
    return http<void>(`/api/projects/${projectId}/annotations/${annId}`, { method: 'DELETE' })
  },

  chat(projectId: string, question: string, nodeId: string | null, sessionId: string | null): AsyncGenerator<ChatEvent> {
    if (USE_MOCK) return mockApi.chat(question, nodeId)
    return sseChat(`/api/projects/${projectId}/chat`, { question, nodeId, sessionId })
  }
}
