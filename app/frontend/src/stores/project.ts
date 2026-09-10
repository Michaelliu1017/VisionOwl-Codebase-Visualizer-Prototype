import { create } from 'zustand'
import { api, isMockApi, subscribeProjectEvents } from '../api/client'
import type {
  Annotation, BindRepoInput, DocgenTask, DocumentLink, GeneratedDocumentContent,
  GraphArtifact, GraphVersion, InvitationCreated, Job, KnowledgeAssetEntry, KnowledgeAssetSummary,
  KnowledgeRun, Project, ProjectEvent, ProjectSummary, RepositoryBinding
} from '../api/types'
import { buildAdjacency, validateGraph, type Adjacency } from '../graph/adjacency'
import { useDingtalk } from './dingtalk'

const LAST_PROJECT_KEY = 'visionowl.lastProjectId'

export interface AnalysisActivity {
  source: 'manual' | 'webhook'
  phase: 'queued' | 'running' | 'completed' | 'failed'
  title: string
  note: string
  beforeSha: string | null
  headSha: string | null
  changedFiles?: string[]
}

export interface DocumentViewer extends GeneratedDocumentContent {
  loading: boolean
  error: string | null
}

export type KnowledgeCapability = 'unknown' | 'available' | 'unavailable'

interface OptionalKnowledgeAssets {
  assets: KnowledgeAssetSummary[]
  capability: KnowledgeCapability
  notice: string | null
}

interface ProjectState {
  projects: ProjectSummary[]
  project: Project | null
  graphVersion: GraphVersion | null
  artifact: GraphArtifact | null
  adjacency: Map<string, Adjacency>
  documents: DocumentLink[]
  annotations: Annotation[]
  knowledgeAssets: KnowledgeAssetSummary[]
  knowledgeRun: KnowledgeRun | null
  knowledgeCapability: KnowledgeCapability
  knowledgeNotice: string | null
  job: Job | null
  analysisActivity: AnalysisActivity | null
  docgenTask: DocgenTask | null
  documentViewer: DocumentViewer | null
  eventConnected: boolean
  loading: boolean
  error: string | null

  bootstrap: () => Promise<void>
  selectProject: (id: string) => Promise<void>
  refreshProjectData: (id: string) => Promise<void>
  handleProjectEvent: (projectId: string, event: ProjectEvent) => Promise<void>
  createProject: (name: string) => Promise<string>
  createInvitation: () => Promise<InvitationCreated>
  joinProject: (key: string) => Promise<void>
  deleteCurrentProject: () => Promise<void>
  bindRepository: (projectId: string, input: BindRepoInput) => Promise<RepositoryBinding>
  removeRepository: (projectId: string, bindingId: string) => Promise<void>
  triggerAnalysis: (force?: boolean) => Promise<void>
  generateKnowledgeAssets: (force?: boolean) => Promise<void>
  downloadKnowledgeAsset: (asset: KnowledgeAssetSummary) => Promise<void>
  openKnowledgeAssetEntry: (asset: KnowledgeAssetSummary, entry: KnowledgeAssetEntry) => Promise<void>
  closeAnalysisActivity: () => void
  createDocument: (input: { nodeId: string | null; title: string; url: string }) => Promise<void>
  deleteDocument: (docId: string) => Promise<void>
  generateDocument: (nodeId: string) => Promise<void>
  retryPendingPublications: () => Promise<void>
  openDocument: (doc: DocumentLink) => Promise<void>
  closeDocumentViewer: () => void
  createAnnotation: (input: { targetId: string; body: string }) => Promise<void>
  deleteAnnotation: (annId: string) => Promise<void>
}

let unsubscribeEvents: (() => void) | null = null
let selectedEpoch = 0
const watchedJobs = new Set<string>()
const watchedKnowledgeRuns = new Set<string>()
const publishingTasks = new Set<string>()
const pendingPublications = new Map<string, { projectId: string; automatic: boolean }>()
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function fetchKnowledgeAssetsOptional(projectId: string): Promise<OptionalKnowledgeAssets> {
  try {
    return {
      assets: await api.listKnowledgeAssets(projectId),
      capability: 'available',
      notice: null
    }
  } catch (error) {
    const status = (error as { status?: number }).status
    const routeMissing = status === 404 || status === 501
    console.info('[visionowl] 工程知识资产扩展不可用，继续加载核心功能:', error)
    return {
      assets: [],
      capability: 'unavailable',
      notice: routeMissing
        ? '当前后端未接入知识资产扩展，代码图谱等原有功能不受影响。'
        : '知识资产扩展暂不可用，代码图谱等原有功能不受影响。'
    }
  }
}

async function publishDocgenTask(
  projectId: string,
  taskId: string,
  automatic: boolean
): Promise<DocumentLink | null> {
  if (publishingTasks.has(taskId)) return null
  pendingPublications.set(taskId, { projectId, automatic })
  const dingtalk = useDingtalk.getState()
  if (!dingtalk.loaded) await dingtalk.bootstrap()
  const connection = useDingtalk.getState().connections.find(item => item.isDefault && item.status === 'active')
  if (!connection) {
    useDingtalk.getState().openSettings()
    return null
  }

  publishingTasks.add(taskId)
  try {
    const publication = await api.getDocgenPublication(projectId, taskId)
    const published = await window.visionowl.dws.publish({
      profile: connection.profileKey,
      title: publication.title,
      markdown: publication.markdown,
      existingNodeId: publication.existingDingtalkNodeId,
      workspaceId: connection.workspaceId,
      folderId: connection.folderId
    })
    const document = await api.confirmDocgenPublication(projectId, taskId, {
      profileKey: connection.profileKey,
      dingtalkNodeId: published.nodeId,
      url: published.url
    })
    pendingPublications.delete(taskId)
    if (!automatic) window.open(document.url, '_blank', 'noopener')
    return document
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/DWS|钉钉|ENTERPRISE_NOT_AUTHORIZED|auth|token|登录|授权|profile|身份/i.test(message)) {
      await useDingtalk.getState().bootstrap()
      useDingtalk.getState().reportError(message)
    }
    throw new Error(message)
  } finally {
    publishingTasks.delete(taskId)
  }
}

async function fetchGraph(projectId: string): Promise<{
  graphVersion: GraphVersion
  artifact: GraphArtifact
  adjacency: Map<string, Adjacency>
} | null> {
  try {
    const graphVersion = await api.getGraphCurrent(projectId)
    const artifact = await api.getGraphArtifact(graphVersion.artifactUrl)
    const problems = validateGraph(artifact)
    if (problems.length > 0) console.warn('[visionowl] graph 校验警告:', problems)
    return { graphVersion, artifact, adjacency: buildAdjacency(artifact) }
  } catch (error) {
    const code = (error as { code?: string }).code
    const status = (error as { status?: number }).status
    if (code === 'NOT_FOUND' || status === 404) return null
    throw error
  }
}

function startJobWatch(jobId: string, projectId: string): void {
  if (watchedJobs.has(jobId)) return
  watchedJobs.add(jobId)
  void (async () => {
    try {
      for (let attempt = 0; attempt < 600; attempt += 1) {
        await sleep(isMockApi ? 700 : 3000)
        if (useProject.getState().project?.id !== projectId) return
        const job = await api.getJob(jobId)
        useProject.setState({ job })
        if (job.status === 'succeeded') {
          await useProject.getState().refreshProjectData(projectId)
          useProject.setState(state => ({
            analysisActivity: state.analysisActivity
              ? { ...state.analysisActivity, phase: 'completed', title: '分析完成', note: '最新代码图谱与文档已同步到本地应用。' }
              : null
          }))
          return
        }
        if (job.status === 'failed' || job.status === 'canceled') {
          useProject.setState(state => ({
            error: job.error ?? '分析失败',
            analysisActivity: state.analysisActivity
              ? { ...state.analysisActivity, phase: 'failed', title: '分析失败', note: job.error ?? '任务未完成' }
              : null
          }))
          return
        }
      }
    } catch (error) {
      useProject.setState({ error: error instanceof Error ? error.message : '无法获取分析任务状态' })
    } finally {
      watchedJobs.delete(jobId)
    }
  })()
}

function startKnowledgeRunWatch(runId: string, projectId: string): void {
  if (watchedKnowledgeRuns.has(runId)) return
  watchedKnowledgeRuns.add(runId)
  void (async () => {
    try {
      for (let attempt = 0; attempt < 600; attempt += 1) {
        await sleep(isMockApi ? 700 : 3000)
        if (useProject.getState().project?.id !== projectId) return
        const run = await api.getKnowledgeRun(projectId, runId)
        const knowledge = await fetchKnowledgeAssetsOptional(projectId)
        useProject.setState({
          knowledgeRun: run,
          knowledgeAssets: knowledge.assets,
          knowledgeCapability: knowledge.capability,
          knowledgeNotice: knowledge.notice
        })
        if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'canceled') return
      }
    } catch (error) {
      useProject.setState({
        knowledgeCapability: 'unavailable',
        knowledgeNotice: error instanceof Error
          ? `知识资产扩展暂不可用：${error.message}`
          : '知识资产扩展暂不可用，现有功能不受影响。'
      })
    } finally {
      watchedKnowledgeRuns.delete(runId)
    }
  })()
}

export const useProject = create<ProjectState>((set, get) => ({
  projects: [],
  project: null,
  graphVersion: null,
  artifact: null,
  adjacency: new Map(),
  documents: [],
  annotations: [],
  knowledgeAssets: [],
  knowledgeRun: null,
  knowledgeCapability: 'unknown',
  knowledgeNotice: null,
  job: null,
  analysisActivity: null,
  docgenTask: null,
  documentViewer: null,
  eventConnected: false,
  loading: false,
  error: null,

  async bootstrap() {
    set({ loading: true, error: null })
    try {
      const projects = await api.listProjects()
      set({ projects })
      if (projects.length === 0) {
        set({ loading: false, project: null, artifact: null })
        return
      }
      const remembered = localStorage.getItem(LAST_PROJECT_KEY)
      const target = projects.find(project => project.id === remembered) ?? projects[0]!
      await get().selectProject(target.id)
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '加载失败' })
    }
  },

  async selectProject(id) {
    const epoch = ++selectedEpoch
    unsubscribeEvents?.()
    unsubscribeEvents = null
    set({
      loading: true,
      error: null,
      graphVersion: null,
      artifact: null,
      adjacency: new Map(),
      documents: [],
      annotations: [],
      knowledgeAssets: [],
      knowledgeRun: null,
      knowledgeCapability: 'unknown',
      knowledgeNotice: null,
      job: null,
      docgenTask: null,
      documentViewer: null,
      eventConnected: false
    })
    localStorage.setItem(LAST_PROJECT_KEY, id)
    try {
      const [project, graph, documents, annotations, jobs, knowledge] = await Promise.all([
        api.getProject(id),
        fetchGraph(id),
        api.listDocuments(id),
        api.listAnnotations(id),
        api.listJobs(id, 10),
        fetchKnowledgeAssetsOptional(id)
      ])
      if (epoch !== selectedEpoch) return
      const job = jobs[0] ?? null
      set({
        project,
        graphVersion: graph?.graphVersion ?? null,
        artifact: graph?.artifact ?? null,
        adjacency: graph?.adjacency ?? new Map(),
        documents,
        annotations,
        knowledgeAssets: knowledge.assets,
        knowledgeCapability: knowledge.capability,
        knowledgeNotice: knowledge.notice,
        job,
        loading: false
      })
      unsubscribeEvents = subscribeProjectEvents(
        id,
        event => { void useProject.getState().handleProjectEvent(id, event) },
        connected => {
          if (useProject.getState().project?.id === id) useProject.setState({ eventConnected: connected })
        }
      )
      if (job && (job.status === 'queued' || job.status === 'running')) {
        set({
          analysisActivity: {
            source: 'manual', phase: job.status, title: '正在分析代码',
            note: '已恢复未完成的云端分析任务。', beforeSha: job.baseCommitSha, headSha: job.targetCommitSha
          }
        })
        startJobWatch(job.id, id)
      }
    } catch (error) {
      if (epoch === selectedEpoch) {
        set({ loading: false, error: error instanceof Error ? error.message : '加载失败' })
      }
    }
  },

  async refreshProjectData(id) {
    if (get().project?.id !== id) return
    try {
      const [project, graph, documents, annotations, knowledge] = await Promise.all([
        api.getProject(id), fetchGraph(id), api.listDocuments(id), api.listAnnotations(id),
        fetchKnowledgeAssetsOptional(id)
      ])
      if (get().project?.id !== id) return
      set(state => ({
        project,
        graphVersion: graph?.graphVersion ?? null,
        artifact: graph?.artifact ?? null,
        adjacency: graph?.adjacency ?? new Map(),
        documents,
        annotations,
        knowledgeAssets: knowledge.assets,
        knowledgeCapability: knowledge.capability,
        knowledgeNotice: knowledge.notice,
        projects: state.projects.map(item => item.id === id
          ? {
              ...item,
              repo: project.binding?.repoFullName ?? null,
              branch: project.binding?.branch ?? null,
              repositoryCount: project.repositories.length,
              currentCommitSha: project.binding?.currentCommitSha ?? null,
              lastAnalyzedAt: project.currentGraph?.createdAt ?? null,
              updatedAt: project.updatedAt
            }
          : item)
      }))
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '刷新项目失败' })
    }
  },

  async handleProjectEvent(projectId, event) {
    if (get().project?.id !== projectId) return
    if (event.type === 'repository.push.received') {
      const data = event.data as { beforeSha?: string; headSha?: string; branch?: string }
      set({
        analysisActivity: {
          source: 'webhook', phase: 'queued', title: '检测到代码变更',
          note: `GitHub Webhook 已触发，正在分析 ${data.branch ?? '目标分支'} 的最新提交。`,
          beforeSha: data.beforeSha ?? null, headSha: data.headSha ?? null
        }
      })
      return
    }
    if (event.type === 'job.created') {
      const job = event.data as Job
      set(state => ({
        job,
        analysisActivity: state.analysisActivity ?? {
          source: job.type === 'incremental' ? 'webhook' : 'manual',
          phase: 'queued', title: job.type === 'incremental' ? '正在分析代码变更' : '正在分析代码',
          note: '任务已进入 Redis 队列，等待 Worker 消费。',
          beforeSha: job.baseCommitSha, headSha: job.targetCommitSha
        }
      }))
      startJobWatch(job.id, projectId)
      return
    }
    if (event.type === 'job.progress') {
      const progress = event.data as { id: string; status: 'running'; progress: number; note?: string }
      const current = get().job
      if (!current || current.id !== progress.id) {
        api.getJob(progress.id).then(job => set({ job })).catch(() => undefined)
      } else {
        set({ job: { ...current, status: progress.status, progress: progress.progress } })
      }
      set(state => ({
        analysisActivity: state.analysisActivity
          ? { ...state.analysisActivity, phase: 'running', title: '正在分析代码变更', note: progress.note ?? state.analysisActivity.note }
          : null
      }))
      return
    }
    if (event.type === 'graph.version.switched') {
      await get().refreshProjectData(projectId)
      set(state => ({
        analysisActivity: state.analysisActivity
          ? { ...state.analysisActivity, note: '新图谱已生成，正在同步文档与任务状态。' }
          : null
      }))
      return
    }
    if (event.type === 'job.succeeded' || event.type === 'job.failed') {
      const job = event.data as Job
      set({ job })
      if (job.status === 'succeeded') await get().refreshProjectData(projectId)
      set(state => ({
        analysisActivity: {
          source: state.analysisActivity?.source ?? (job.type === 'incremental' ? 'webhook' : 'manual'),
          phase: job.status === 'succeeded' ? 'completed' : 'failed',
          title: job.status === 'succeeded' ? '分析完成' : '分析失败',
          note: job.status === 'succeeded' ? '最新代码图谱与文档已同步到本地应用。' : job.error ?? '任务未完成',
          beforeSha: job.baseCommitSha,
          headSha: job.targetCommitSha
        },
        error: job.status === 'failed' ? job.error ?? '分析失败' : state.error
      }))
      return
    }
    if (event.type === 'document.publication.ready') {
      const data = event.data as { taskId: string; automatic?: boolean }
      try {
        const document = await publishDocgenTask(projectId, data.taskId, data.automatic !== false)
        if (document && get().project?.id === projectId) {
          const documents = await api.listDocuments(projectId)
          set(state => ({
            documents,
            docgenTask: state.docgenTask?.taskId === data.taskId
              ? { ...state.docgenTask, status: 'succeeded', docId: document.id }
              : state.docgenTask
          }))
        }
      } catch (error) {
        console.error('[visionowl] 自动发布钉钉文档失败:', error)
      }
      return
    }
    if (event.type === 'knowledge.run.updated') {
      const run = event.data as KnowledgeRun
      const knowledge = await fetchKnowledgeAssetsOptional(projectId)
      set({
        knowledgeRun: run,
        knowledgeAssets: knowledge.assets,
        knowledgeCapability: knowledge.capability,
        knowledgeNotice: knowledge.notice
      })
      if (!['succeeded', 'failed', 'canceled'].includes(run.status)) {
        startKnowledgeRunWatch(run.id, projectId)
      }
      return
    }
    if (
      event.type === 'knowledge.asset.published' ||
      event.type === 'skilllab.run.updated' ||
      event.type === 'skill.version.published'
    ) {
      const knowledge = await fetchKnowledgeAssetsOptional(projectId)
      set({
        knowledgeAssets: knowledge.assets,
        knowledgeCapability: knowledge.capability,
        knowledgeNotice: knowledge.notice
      })
      return
    }
    if (event.type.startsWith('document.')) {
      set({ documents: await api.listDocuments(projectId) })
      return
    }
    if (event.type.startsWith('annotation.')) {
      set({ annotations: await api.listAnnotations(projectId) })
    }
  },

  async createProject(name) {
    const project = await api.createProject(name)
    set(state => ({
      projects: [...state.projects, {
        id: project.id, name: project.name, status: project.status, myRole: project.myRole,
        repo: null, branch: null, repositoryCount: 0,
        currentCommitSha: null, lastAnalyzedAt: null, updatedAt: project.updatedAt
      }]
    }))
    return project.id
  },

  async createInvitation() {
    const project = get().project
    if (!project) throw new Error('请先选择一个 Project')
    return api.createInvitation(project.id)
  },

  async joinProject(key) {
    const normalized = key.trim()
    if (!normalized) throw new Error('请输入邀请码')
    const redeemed = await api.redeemInvitation(normalized)
    const projects = await api.listProjects()
    set({ projects })
    await get().selectProject(redeemed.projectId)
  },

  async deleteCurrentProject() {
    const project = get().project
    if (!project) throw new Error('请先选择一个 Project')
    if (project.myRole !== 'owner') throw new Error('只有 Owner 可以删除 Project')
    await api.deleteProject(project.id)
    selectedEpoch += 1
    unsubscribeEvents?.()
    unsubscribeEvents = null
    localStorage.removeItem(LAST_PROJECT_KEY)
    const projects = await api.listProjects()
    set({
      projects,
      project: null,
      graphVersion: null,
      artifact: null,
      adjacency: new Map(),
      documents: [],
      annotations: [],
      knowledgeAssets: [],
      knowledgeRun: null,
      knowledgeCapability: 'unknown',
      knowledgeNotice: null,
      job: null,
      analysisActivity: null,
      documentViewer: null,
      eventConnected: false,
      error: null
    })
    if (projects[0]) await get().selectProject(projects[0].id)
  },

  async bindRepository(projectId, input) {
    const binding = await api.bindRepository(projectId, input)
    set(state => ({
      projects: state.projects.map(project => project.id === projectId
        ? {
            ...project,
            repo: project.repo ?? binding.repoFullName,
            branch: project.branch ?? binding.branch,
            repositoryCount: project.repositoryCount + 1
          }
        : project),
      project: state.project?.id === projectId
        ? {
            ...state.project,
            repositories: [...state.project.repositories, binding],
            binding: state.project.binding ?? binding
          }
        : state.project
    }))
    return binding
  },

  async removeRepository(projectId, bindingId) {
    await api.deleteRepository(projectId, bindingId)
    const repositories = await api.listRepositories(projectId)
    set(state => ({
      projects: state.projects.map(project => project.id === projectId
        ? {
            ...project,
            repo: repositories[0]?.repoFullName ?? null,
            branch: repositories[0]?.branch ?? null,
            repositoryCount: repositories.length
          }
        : project),
      project: state.project?.id === projectId
        ? { ...state.project, repositories, binding: repositories[0] ?? null }
        : state.project
    }))
  },

  async triggerAnalysis(force = false) {
    const project = get().project
    if (!project || project.repositories.length === 0) {
      set({ error: '该项目尚未绑定仓库，请先绑定后再触发分析' })
      return
    }
    try {
      const job = await api.createJob(project.id, { force })
      set({
        job,
        error: null,
        analysisActivity: {
          source: 'manual', phase: 'queued',
          title: force ? '正在重新分析代码架构' : '正在分析代码',
          note: force
            ? '强制全量任务已投递到 Redis，旧图谱会保留到新版本验证成功。'
            : '任务已投递到 Redis，等待 Worker 和 Runner 执行。',
          beforeSha: job.baseCommitSha, headSha: job.targetCommitSha
        }
      })
      startJobWatch(job.id, project.id)
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '触发分析失败' })
    }
  },

  async generateKnowledgeAssets(force = false) {
    const project = get().project
    if (!project) throw new Error('请先选择一个 Project')
    if (get().knowledgeCapability !== 'available') {
      set({ knowledgeNotice: '当前环境尚未接入知识资产扩展，代码图谱等原有功能可继续使用。' })
      return
    }
    if (!get().graphVersion) {
      set({ knowledgeNotice: '项目尚无代码图谱，请先完成代码分析。' })
      return
    }
    try {
      const run = await api.createKnowledgeRun(project.id, force)
      const knowledge = await fetchKnowledgeAssetsOptional(project.id)
      set({
        knowledgeRun: run,
        knowledgeAssets: knowledge.assets,
        knowledgeCapability: knowledge.capability,
        knowledgeNotice: knowledge.notice
      })
      startKnowledgeRunWatch(run.id, project.id)
    } catch (error) {
      set({
        knowledgeNotice: error instanceof Error
          ? `无法触发工程知识生成：${error.message}`
          : '无法触发工程知识生成，现有功能不受影响。'
      })
    }
  },

  async downloadKnowledgeAsset(asset) {
    const project = get().project
    if (!project || !asset.versionId) return
    try {
      const fallback = `${asset.kind}-v${asset.version ?? 1}.zip`
      const { blob, fileName } = await api.downloadKnowledgeAsset(project.id, asset.id, fallback)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = fileName
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (error) {
      set({
        knowledgeNotice: error instanceof Error
          ? `下载知识资产失败：${error.message}`
          : '下载知识资产失败。'
      })
    }
  },

  async openKnowledgeAssetEntry(asset, entry) {
    const project = get().project
    if (!project) return
    set({
      documentViewer: {
        docId: `${asset.id}:${entry.id}`,
        title: entry.title,
        updatedAt: asset.updatedAt,
        markdown: '',
        loading: true,
        error: null
      }
    })
    try {
      const markdown = await api.getKnowledgeAssetContent(project.id, asset.id, entry.path)
      set({
        documentViewer: {
          docId: `${asset.id}:${entry.id}`,
          title: entry.title,
          updatedAt: asset.updatedAt,
          markdown,
          loading: false,
          error: null
        }
      })
    } catch (error) {
      set(state => ({
        documentViewer: state.documentViewer
          ? { ...state.documentViewer, loading: false, error: error instanceof Error ? error.message : '知识资产加载失败' }
          : null
      }))
    }
  },

  closeAnalysisActivity() {
    const phase = get().analysisActivity?.phase
    if (phase === 'completed' || phase === 'failed') set({ analysisActivity: null })
  },

  async createDocument(input) {
    const project = get().project
    if (!project) return
    const doc = await api.createDocument(project.id, {
      scope: input.nodeId ? 'module' : 'global', nodeId: input.nodeId,
      title: input.title, url: input.url, docType: 'dingtalk'
    })
    set(state => ({ documents: [...state.documents, doc] }))
  },

  async deleteDocument(docId) {
    const project = get().project
    if (!project) return
    await api.deleteDocument(project.id, docId)
    set(state => ({ documents: state.documents.filter(doc => doc.id !== docId) }))
  },

  async generateDocument(nodeId) {
    const project = get().project
    if (!project || get().docgenTask?.status === 'running' || get().docgenTask?.status === 'pending' || get().docgenTask?.status === 'ready_to_publish') return
    try {
      const dingtalk = useDingtalk.getState()
      if (!dingtalk.loaded) await dingtalk.bootstrap()
      if (!useDingtalk.getState().connections.some(connection => connection.isDefault && connection.status === 'active')) {
        useDingtalk.getState().openSettings()
        return
      }
      let task = await api.generateDocument(project.id, nodeId)
      set({ docgenTask: task, error: null })
      for (let attempt = 0; attempt < 300; attempt += 1) {
        await sleep(isMockApi ? 500 : 2000)
        if (get().project?.id !== project.id) return
        task = await api.getDocgenTask(project.id, task.taskId)
        set({ docgenTask: task })
        if (task.status === 'failed') throw new Error(task.error ?? '文档生成失败')
        if (task.status === 'ready_to_publish') {
          const document = await publishDocgenTask(project.id, task.taskId, false)
          if (!document) return
          const documents = await api.listDocuments(project.id)
          set({
            documents,
            docgenTask: { ...task, status: 'succeeded', docId: document.id }
          })
          return
        }
        if (task.status === 'succeeded' && task.docId) {
          const documents = await api.listDocuments(project.id)
          set({ documents })
          const doc = documents.find(item => item.id === task.docId)
          if (doc) await get().openDocument(doc)
          return
        }
      }
      throw new Error('文档生成超时')
    } catch (error) {
      const message = error instanceof Error ? error.message : '文档生成失败'
      const dingtalkError = /DWS|钉钉|ENTERPRISE_NOT_AUTHORIZED|企业.*授权|身份/i.test(message)
      if (dingtalkError) useDingtalk.getState().reportError(message)
      set(state => ({
        error: dingtalkError ? null : message,
        docgenTask: state.docgenTask ? { ...state.docgenTask, status: 'failed', error: message } : null
      }))
    }
  },

  async retryPendingPublications() {
    const projectId = get().project?.id
    if (!projectId) return
    for (const [taskId, pending] of pendingPublications) {
      if (pending.projectId !== projectId) continue
      try {
        const document = await publishDocgenTask(projectId, taskId, pending.automatic)
        if (document && get().project?.id === projectId) {
          set({ documents: await api.listDocuments(projectId) })
        }
      } catch (error) {
        console.error('[visionowl] 重试发布钉钉文档失败:', error)
      }
    }
  },

  async openDocument(doc) {
    if (doc.docType !== 'generated') {
      window.open(doc.url, '_blank', 'noopener')
      return
    }
    const project = get().project
    if (!project) return
    set({
      documentViewer: {
        docId: doc.id, title: doc.title, updatedAt: doc.updatedAt,
        markdown: '', loading: true, error: null
      }
    })
    try {
      const content = await api.getGeneratedDocument(project.id, doc.id)
      set({ documentViewer: { ...content, loading: false, error: null } })
    } catch (error) {
      set(state => ({
        documentViewer: state.documentViewer
          ? { ...state.documentViewer, loading: false, error: error instanceof Error ? error.message : '文档加载失败' }
          : null
      }))
    }
  },

  closeDocumentViewer() {
    set({ documentViewer: null })
  },

  async createAnnotation(input) {
    const project = get().project
    if (!project) return
    const annotation = await api.createAnnotation(project.id, {
      targetKind: 'node', targetId: input.targetId, body: input.body
    })
    set(state => ({ annotations: [...state.annotations, annotation] }))
  },

  async deleteAnnotation(annId) {
    const project = get().project
    if (!project) return
    await api.deleteAnnotation(project.id, annId)
    set(state => ({ annotations: state.annotations.filter(annotation => annotation.id !== annId) }))
  }
}))
