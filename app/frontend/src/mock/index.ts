/**
 * Mock 实现 —— 数据与《协同开发.md》§8 canonical demo 完全一致。
 * 后端 seed 出的同一份数据保证联调时切 BaseURL 即可。
 */
import type {
  Annotation, AuthResult, BindRepoInput, ChatEvent, DingtalkAuthTask, DingtalkConnection,
  DocumentLink, GraphArtifact, DocgenTask, GeneratedDocumentContent, GraphVersion, InvitationCreated, InvitationRedeemed, Job, Project, ProjectSummary,
  PublicBranch, PublicRepository, RepositoryBinding, User
} from '../api/types'
import graphDemo from './fixtures/graph.demo.json'

const now = '2026-08-04T10:00:00Z'

const users: (User & { password: string })[] = [
  { id: 'u-owner-0001', email: 'owner@demo.dev', name: 'Owner Demo', createdAt: now, password: 'demo1234' },
  { id: 'u-editor-0001', email: 'editor@demo.dev', name: 'Editor Demo', createdAt: now, password: 'demo1234' }
]

const PROJECT_ID = 'p-eventhub-0001'

const demoBinding: RepositoryBinding = {
  id: 'repo-binding-eventhub',
  repoFullName: 'team-046/eventhub-fixture',
  branch: 'main',
  repositoryId: 461046,
  installationId: 88046,
  currentCommitSha: '171b8f0',
  isPrimary: true
}

const project: Project = {
  id: PROJECT_ID,
  name: 'EventHub',
  status: 'active',
  myRole: 'owner',
  owner: { id: 'u-owner-0001', name: 'Owner Demo' },
  repositories: [demoBinding],
  binding: demoBinding,
  currentGraph: {
    versionNo: 1,
    commitSha: '171b8f0',
    repositoryCommits: { 'team-046/eventhub-fixture': '171b8f0' },
    createdAt: now
  },
  createdAt: now,
  updatedAt: now
}

// 多项目内存库:新建项目与绑定仓库均落入此处,使 Mock 与真实后端行为一致
const projects: Project[] = [project]
const invitations = new Map<string, string>()
const jobs = new Map<string, Job>()
const docgenTasks = new Map<string, DocgenTask & { startedAt: number }>()
const generatedContent = new Map<string, GeneratedDocumentContent>()
const dingtalkConnections: DingtalkConnection[] = [{
  id: 'ding-conn-demo', profileKey: 'corp-demo:user-demo', corpId: 'corp-demo',
  corpName: 'VisionOwl Demo', userId: 'user-demo', userName: 'Owner Demo',
  status: 'active', isDefault: true, workspaceId: null, folderId: null,
  lastVerifiedAt: now, createdAt: now, updatedAt: now
}]
const dingtalkTasks = new Map<string, DingtalkAuthTask & { startedAt: number }>()
/** 任务发起时间:getJob 据此推算进度,不依赖定时器 */
const jobStartedAt = new Map<string, number>()

const graphVersion: GraphVersion = {
  versionNo: 1,
  commitSha: '171b8f0',
  repositoryCommits: { 'team-046/eventhub-fixture': '171b8f0' },
  jobId: null,
  stats: { nodeCount: 20, edgeCount: 34, inferredCount: 2 },
  artifactUrl: `/api/projects/${PROJECT_ID}/graph/versions/1/artifact`,
  createdAt: now
}

const documents: DocumentLink[] = [
  {
    id: 'doc-global-0001', scope: 'global', nodeId: null,
    title: 'EventHub 架构总览', url: 'https://alidocs.dingtalk.com/i/nodes/demo-global',
    docType: 'dingtalk', status: 'ok',
    updatedBy: { id: 'u-owner-0001', name: 'Owner Demo' },
    createdAt: now, updatedAt: now
  },
  {
    id: 'doc-booking-0001', scope: 'module', nodeId: 'module:modules/booking',
    title: '订单模块说明', url: 'https://alidocs.dingtalk.com/i/nodes/demo-booking',
    docType: 'dingtalk', status: 'maybe_stale',
    updatedBy: { id: 'u-owner-0001', name: 'Owner Demo' },
    createdAt: now, updatedAt: now
  }
]

const annotations: Annotation[] = [
  {
    id: 'ann-0001', targetKind: 'node', targetId: 'module:modules/booking',
    body: '幂等键在 v2 迁移后改为 orderId+ts',
    author: { id: 'u-owner-0001', name: 'Owner Demo' },
    resolved: false, createdAt: now, updatedAt: now
  }
]

// 当前登录用户(写操作的 author/updatedBy 归属)
let currentUser: User = users[0]
let idSeq = 100
const genId = (p: string) => `${p}-${String(idSeq++).padStart(4, '0')}`
const nowIso = () => new Date().toISOString()

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

const repositoryCommitsOf = (item: Project): Record<string, string> => Object.fromEntries(
  item.repositories.map(repository => [
    repository.repoFullName,
    repository.currentCommitSha ?? '171b8f0bfb419fd6fdd898faf802056f9b0fb18f'
  ])
)

export const mockApi = {
  async login(email: string, password: string): Promise<AuthResult> {
    await sleep(300)
    const u = users.find(x => x.email === email && x.password === password)
    if (!u) {
      throw Object.assign(new Error('邮箱或密码错误'), { code: 'VALIDATION_FAILED' })
    }
    const { password: _pw, ...user } = u
    currentUser = user
    return { user, token: `mock-token-${u.id}` }
  },

  async listProjects(): Promise<ProjectSummary[]> {
    await sleep(200)
    return projects.map(p => ({
      id: p.id, name: p.name, status: p.status,
      myRole: currentUser.id === p.owner.id ? 'owner' : 'editor',
      repo: p.binding?.repoFullName ?? null,
      branch: p.binding?.branch ?? null,
      repositoryCount: p.repositories.length,
      currentCommitSha: p.binding?.currentCommitSha ?? null,
      lastAnalyzedAt: p.currentGraph ? now : null,
      updatedAt: p.updatedAt
    }))
  },

  async getProject(id: string): Promise<Project> {
    await sleep(150)
    const p = projects.find(x => x.id === id)
    if (!p) throw Object.assign(new Error('项目不存在'), { code: 'NOT_FOUND' })
    return {
      ...p,
      myRole: currentUser.id === p.owner.id ? 'owner' : 'editor',
      repositories: p.repositories.map(item => ({ ...item })),
      binding: p.binding ? { ...p.binding } : null,
      currentGraph: p.currentGraph
        ? { ...p.currentGraph, repositoryCommits: { ...p.currentGraph.repositoryCommits } }
        : null
    }
  },

  async createProject(name: string): Promise<Project> {
    await sleep(220)
    const p: Project = {
      id: genId('p'),
      name,
      status: 'active',
      myRole: 'owner',
      owner: { id: currentUser.id, name: currentUser.name },
      repositories: [],
      binding: null,
      currentGraph: null,
      createdAt: nowIso(),
      updatedAt: nowIso()
    }
    projects.push(p)
    return p
  },

  async createInvitation(projectId: string): Promise<InvitationCreated> {
    await sleep(220)
    const p = projects.find(item => item.id === projectId)
    if (!p) throw Object.assign(new Error('项目不存在'), { code: 'NOT_FOUND' })
    const key = `vo-inv-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
    invitations.set(key, projectId)
    return { id: genId('inv'), key, role: 'editor', expiresAt: null, maxUses: null }
  },

  async redeemInvitation(key: string): Promise<InvitationRedeemed> {
    await sleep(220)
    const projectId = invitations.get(key.trim())
    if (!projectId) throw Object.assign(new Error('邀请码无效或已撤销'), { code: 'INVITATION_INVALID' })
    return { projectId, role: currentUser.id === projects.find(item => item.id === projectId)?.owner.id ? 'owner' : 'editor' }
  },

  async deleteProject(projectId: string): Promise<void> {
    await sleep(220)
    const index = projects.findIndex(item => item.id === projectId)
    if (index < 0) throw Object.assign(new Error('项目不存在'), { code: 'NOT_FOUND' })
    if (projects[index]!.owner.id !== currentUser.id) {
      throw Object.assign(new Error('只有 Owner 可以删除 Project'), { code: 'FORBIDDEN' })
    }
    projects.splice(index, 1)
    for (const [key, value] of invitations) if (value === projectId) invitations.delete(key)
  },

  async bindRepository(projectId: string, input: BindRepoInput): Promise<RepositoryBinding> {
    await sleep(240)
    const p = projects.find(x => x.id === projectId)
    if (!p) throw Object.assign(new Error('项目不存在'), { code: 'NOT_FOUND' })
    const full =
      input.repoFullName ??
      (input.repoUrl ?? '')
        .trim()
        .replace(/\.git$/i, '')
        .replace(/\/+$/, '')
        .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
    if (!/^[\w.-]+\/[\w.-]+$/.test(full)) {
      throw Object.assign(new Error('仓库地址无法解析为 owner/repo'), { code: 'VALIDATION_FAILED' })
    }
    if (p.repositories.some(item => item.repoFullName === full && item.branch === input.branch)) {
      throw Object.assign(new Error('该仓库与分支已加入当前项目'), { code: 'DUPLICATE' })
    }
    const binding: RepositoryBinding = {
      id: genId('repo-binding'),
      repoFullName: full,
      branch: input.branch,
      repositoryId: 0,
      installationId: input.installationId ?? null,
      currentCommitSha: null,
      isPrimary: p.repositories.length === 0
    }
    p.repositories.push(binding)
    p.binding ??= binding
    p.updatedAt = nowIso()
    return { ...binding }
  },

  async listRepositories(projectId: string): Promise<RepositoryBinding[]> {
    await sleep(100)
    const p = projects.find(item => item.id === projectId)
    if (!p) throw Object.assign(new Error('项目不存在'), { code: 'NOT_FOUND' })
    return p.repositories.map(item => ({ ...item }))
  },

  async deleteRepository(projectId: string, bindingId: string): Promise<void> {
    await sleep(140)
    const p = projects.find(item => item.id === projectId)
    if (!p) throw Object.assign(new Error('项目不存在'), { code: 'NOT_FOUND' })
    const index = p.repositories.findIndex(item => item.id === bindingId)
    if (index < 0) throw Object.assign(new Error('仓库绑定不存在'), { code: 'NOT_FOUND' })
    const removedPrimary = p.repositories[index]!.isPrimary
    p.repositories.splice(index, 1)
    if (removedPrimary && p.repositories[0]) p.repositories[0].isPrimary = true
    p.binding = p.repositories.find(item => item.isPrimary) ?? p.repositories[0] ?? null
    p.updatedAt = nowIso()
  },

  async inspectPublicRepository(repo: string): Promise<PublicRepository> {
    await sleep(180)
    const fullName = repo.replace(/^https?:\/\/(?:www\.)?github\.com\//, '').replace(/\.git$/, '')
    return { id: 1, fullName, defaultBranch: 'main', htmlUrl: `https://github.com/${fullName}` }
  },

  async listPublicBranches(_repo: string): Promise<PublicBranch[]> {
    await sleep(160)
    return [
      { name: 'main', commitSha: '171b8f0bfb419fd6fdd898faf802056f9b0fb18f' },
      { name: 'develop', commitSha: 'd53f5f1806d545caf441e7c0a4e524f84b09123a' }
    ]
  },

  async createJob(projectId: string, input: { force?: boolean } = {}): Promise<Job> {
    await sleep(180)
    const p = projects.find(item => item.id === projectId)
    if (!p) throw Object.assign(new Error('项目不存在'), { code: 'NOT_FOUND' })
    const job: Job = {
      id: genId('job'),
      projectId,
      type: 'full',
      status: 'queued',
      progress: 0,
      baseCommitSha: null,
      targetCommitSha: null,
      repositoryCommits: repositoryCommitsOf(p),
      error: null,
      credits: null,
      forceReanalysis: input.force ?? false,
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null
    }
    jobs.set(job.id, job)
    jobStartedAt.set(job.id, Date.now())
    return job
  },

  async getJob(jobId: string): Promise<Job> {
    await sleep(80)
    const j = jobs.get(jobId)
    if (!j) throw Object.assign(new Error('任务不存在'), { code: 'NOT_FOUND' })
    if (j.status === 'succeeded' || j.status === 'failed') return j

    // 按经过时长推算进度:不依赖 setInterval,避免后台标签页定时器节流导致卡住
    const elapsed = Date.now() - (jobStartedAt.get(jobId) ?? Date.now())
    const TOTAL = 6000
    if (elapsed >= TOTAL) {
      const done: Job = {
        ...j, status: 'succeeded', progress: 100,
        targetCommitSha: '171b8f0', repositoryCommits: j.repositoryCommits, credits: 0,
        startedAt: j.startedAt ?? nowIso(), finishedAt: nowIso()
      }
      jobs.set(jobId, done)
      const p = projects.find(x => x.id === j.projectId)
      if (p) {
        for (const repository of p.repositories) {
          repository.currentCommitSha = j.repositoryCommits[repository.repoFullName] ?? '171b8f0'
        }
        p.currentGraph = {
          versionNo: 1,
          commitSha: '171b8f0',
          repositoryCommits: repositoryCommitsOf(p),
          createdAt: nowIso()
        }
      }
      return done
    }
    const running: Job = {
      ...j,
      status: elapsed < 600 ? 'queued' : 'running',
      progress: Math.min(95, Math.round((elapsed / TOTAL) * 100)),
      startedAt: j.startedAt ?? nowIso()
    }
    jobs.set(jobId, running)
    return running
  },

  async listJobs(projectId: string, limit: number): Promise<Job[]> {
    return [...jobs.values()].filter(job => job.projectId === projectId).slice(-limit).reverse()
  },

  async getGraphCurrent(projectId: string): Promise<GraphVersion> {
    await sleep(150)
    const p = projects.find(x => x.id === projectId)
    // 新建未分析的项目尚无版本,与真实后端一致地报 404
    if (!p?.currentGraph) {
      throw Object.assign(new Error('该项目尚无图谱版本'), { code: 'NOT_FOUND' })
    }
    return {
      ...graphVersion,
      commitSha: p.currentGraph.commitSha,
      repositoryCommits: p.currentGraph.repositoryCommits,
      createdAt: p.currentGraph.createdAt
    }
  },

  async getGraphArtifact(_artifactUrl: string): Promise<GraphArtifact> {
    await sleep(250)
    return graphDemo as unknown as GraphArtifact
  },

  async listDocuments(_projectId: string): Promise<DocumentLink[]> {
    await sleep(120)
    // 返回拷贝:禁止 store 与 mock 共享可变数组引用,否则写操作会双重追加
    return [...documents]
  },

  async listAnnotations(_projectId: string): Promise<Annotation[]> {
    await sleep(120)
    return [...annotations]
  },

  async createDocument(input: {
    scope: 'global' | 'module'; nodeId: string | null
    title: string; url: string; docType: DocumentLink['docType']
  }): Promise<DocumentLink> {
    await sleep(180)
    const doc: DocumentLink = {
      id: genId('doc'),
      scope: input.scope,
      nodeId: input.nodeId,
      title: input.title,
      url: input.url,
      docType: input.docType,
      status: 'ok',
      updatedBy: { id: currentUser.id, name: currentUser.name },
      createdAt: nowIso(),
      updatedAt: nowIso()
    }
    documents.push(doc)
    return doc
  },

  async deleteDocument(docId: string): Promise<void> {
    await sleep(120)
    const i = documents.findIndex(d => d.id === docId)
    if (i >= 0) documents.splice(i, 1)
  },

  async generateDocument(nodeId: string): Promise<DocgenTask> {
    const task: DocgenTask & { startedAt: number } = {
      taskId: genId('docgen'), status: 'pending', nodeId, commitSha: '171b8f0',
      docId: null, error: null, credits: null, startedAt: Date.now()
    }
    docgenTasks.set(task.taskId, task)
    return task
  },

  async getDocgenTask(taskId: string): Promise<DocgenTask> {
    const task = docgenTasks.get(taskId)
    if (!task) throw new Error('生成任务不存在')
    if (Date.now() - task.startedAt < 1800) {
      return { ...task, status: 'running' }
    }
    if (!task.docId) {
      const docId = genId('doc')
      task.docId = docId
      task.status = 'succeeded'
      task.credits = 1
      const doc: DocumentLink = {
        id: docId, scope: 'module', nodeId: task.nodeId,
        title: `${task.nodeId.replace('module:', '')} 代码文档`,
        url: `https://alidocs.dingtalk.com/i/nodes/${docId}`, docType: 'dingtalk', status: 'ok',
        updatedBy: { id: currentUser.id, name: currentUser.name },
        createdAt: nowIso(), updatedAt: nowIso()
      }
      documents.push(doc)
      generatedContent.set(docId, {
        docId, title: doc.title, updatedAt: doc.updatedAt,
        markdown: `# ${doc.title}\n\n## 模块职责\n\n这是 Mock 模式生成的模块代码文档。`
      })
    }
    return task
  },

  async getGeneratedDocument(docId: string): Promise<GeneratedDocumentContent> {
    const content = generatedContent.get(docId)
    if (!content) throw new Error('文档内容不存在')
    return content
  },

  async listDingtalkConnections(): Promise<{ configured: boolean; connections: DingtalkConnection[] }> {
    return { configured: dingtalkConnections.some(item => item.status === 'active'), connections: [...dingtalkConnections] }
  },

  async startDingtalkConnection(): Promise<DingtalkAuthTask> {
    const task: DingtalkAuthTask & { startedAt: number } = {
      taskId: genId('ding-auth'), status: 'waiting', stage: 'waiting_authorization',
      authorizationUrl: 'https://login.dingtalk.com/device?user_code=OWL-DEMO',
      userCode: 'OWL-DEMO', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      connection: null, error: null, startedAt: Date.now()
    }
    dingtalkTasks.set(task.taskId, task)
    return task
  },

  async getDingtalkConnectionTask(taskId: string): Promise<DingtalkAuthTask> {
    const task = dingtalkTasks.get(taskId)
    if (!task) throw new Error('授权任务不存在')
    if (Date.now() - task.startedAt < 1200) return task
    const connection: DingtalkConnection = {
      ...dingtalkConnections[0], id: genId('ding-conn'), profileKey: `corp-demo:user-${idSeq}`,
      userId: `user-${idSeq}`, userName: '新钉钉身份', isDefault: true, updatedAt: nowIso()
    }
    dingtalkConnections.forEach(item => { item.isDefault = false })
    dingtalkConnections.unshift(connection)
    return { ...task, status: 'succeeded', stage: 'completed', connection }
  },

  async selectDingtalkConnection(connectionId: string): Promise<DingtalkConnection> {
    const selected = dingtalkConnections.find(item => item.id === connectionId)
    if (!selected) throw new Error('钉钉身份不存在')
    dingtalkConnections.forEach(item => { item.isDefault = item.id === connectionId })
    return { ...selected, isDefault: true }
  },

  async updateDingtalkConnection(
    connectionId: string,
    input: { workspaceId: string | null; folderId: string | null }
  ): Promise<DingtalkConnection> {
    const selected = dingtalkConnections.find(item => item.id === connectionId)
    if (!selected) throw new Error('钉钉身份不存在')
    Object.assign(selected, input, { updatedAt: nowIso() })
    return { ...selected }
  },

  async deleteDingtalkConnection(connectionId: string): Promise<void> {
    const index = dingtalkConnections.findIndex(item => item.id === connectionId)
    if (index >= 0) dingtalkConnections.splice(index, 1)
    if (dingtalkConnections[0]) dingtalkConnections[0].isDefault = true
  },

  async createAnnotation(input: {
    targetKind: 'node' | 'edge'; targetId: string; body: string
  }): Promise<Annotation> {
    await sleep(150)
    const ann: Annotation = {
      id: genId('ann'),
      targetKind: input.targetKind,
      targetId: input.targetId,
      body: input.body,
      author: { id: currentUser.id, name: currentUser.name },
      resolved: false,
      createdAt: nowIso(),
      updatedAt: nowIso()
    }
    annotations.push(ann)
    return ann
  },

  async deleteAnnotation(annId: string): Promise<void> {
    await sleep(120)
    const i = annotations.findIndex(a => a.id === annId)
    if (i >= 0) annotations.splice(i, 1)
  },

  /** 模拟 chat SSE:按图谱邻接生成规则回答,流式吐字 */
  async *chat(question: string, nodeId: string | null): AsyncGenerator<ChatEvent> {
    const g = graphDemo as unknown as GraphArtifact
    yield { type: 'chat.meta', sessionId: `sess-${Date.now()}` }
    await sleep(350)

    const node = nodeId ? g.nodes.find(n => n.id === nodeId) : undefined
    let answer: string
    let highlightNodes: string[] = []
    let highlightEdges: string[] = []

    if (node) {
      const inbound = g.edges.filter(e => e.target === node.id)
      const outbound = g.edges.filter(e => e.source === node.id)
      const nameOf = (id: string) => g.nodes.find(n => n.id === id)?.name ?? id
      answer =
        `${node.name} 的职责:${node.summary}\n` +
        `上游调用方 ${inbound.length} 个:${inbound.map(e => nameOf(e.source)).join('、') || '无'};` +
        `下游依赖 ${outbound.length} 个:${outbound.map(e => nameOf(e.target)).join('、') || '无'}。` +
        (outbound.some(e => e.inferred) ? '\n注意:其中含推断关系,建议人工确认。' : '')
      highlightNodes = [node.id, ...inbound.map(e => e.source), ...outbound.map(e => e.target)]
      highlightEdges = [...inbound, ...outbound].map(e => e.id)
    } else {
      answer =
        `当前图谱共 ${g.stats.nodeCount} 个节点、${g.stats.edgeCount} 条关系` +
        `(含 ${g.stats.inferredCount} 条推断)。选中一个模块后我可以做更精确的分析。`
    }

    // 流式吐字
    for (let i = 0; i < answer.length; i += 6) {
      yield { type: 'chat.delta', text: answer.slice(i, i + 6) }
      await sleep(24)
    }

    if (node) {
      yield { type: 'chat.evidence', items: node.evidence }
      await sleep(120)
      yield { type: 'chat.action', action: 'highlight', nodeIds: highlightNodes, edgeIds: highlightEdges }
    }
    // 简单地把"影响/最新/过期"类问题也标为非推断的规则回答
    void question
    yield { type: 'chat.done', sessionId: 'sess-mock', credits: 0, inferred: node ? g.edges.some(e => (e.source === node.id || e.target === node.id) && e.inferred) : false, provider: 'rules' }
  }
}
