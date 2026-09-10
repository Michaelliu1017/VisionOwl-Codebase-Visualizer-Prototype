import { useEffect } from 'react'
import { AgentConsole } from './components/agent/AgentConsole'
import { GraphCanvas } from './components/canvas/GraphCanvas'
import { DetailPanel } from './components/layout/DetailPanel'
import { SideTree } from './components/layout/SideTree'
import { StatusBar } from './components/layout/StatusBar'
import { ViewSwitcher } from './components/layout/TopBar'
import { Login } from './components/Login'
import { DingtalkSetupModal } from './components/DingtalkSetupModal'
import { Markdown } from './components/common/Markdown'
import { useProject } from './stores/project'
import { useDingtalk } from './stores/dingtalk'
import { useSession } from './stores/session'

export default function App() {
  const user = useSession(s => s.user)
  if (!user) return <Login />
  return <Workspace />
}

function Workspace() {
  const bootstrap = useProject(s => s.bootstrap)
  const loading = useProject(s => s.loading)
  const error = useProject(s => s.error)
  const artifact = useProject(s => s.artifact)
  const project = useProject(s => s.project)
  const projects = useProject(s => s.projects)
  const job = useProject(s => s.job)
  const analysisActivity = useProject(s => s.analysisActivity)
  const closeAnalysisActivity = useProject(s => s.closeAnalysisActivity)
  const documentViewer = useProject(s => s.documentViewer)
  const closeDocumentViewer = useProject(s => s.closeDocumentViewer)
  const bootstrapDingtalk = useDingtalk(s => s.bootstrap)
  const currentDingtalkProfile = useDingtalk(s => s.connections.find(connection => connection.isDefault && connection.status === 'active')?.profileKey ?? null)
  const retryPendingPublications = useProject(s => s.retryPendingPublications)

  useEffect(() => {
    void bootstrap()
    void bootstrapDingtalk()
  }, [bootstrap, bootstrapDingtalk])

  useEffect(() => {
    if (currentDingtalkProfile) void retryPendingPublications()
  }, [currentDingtalkProfile, retryPendingPublications])

  const analyzing = job?.status === 'queued' || job?.status === 'running'

  return (
    <div className="vo-shell">
      <div className="vo-workspace">
        <SideTree />
        <main className="vo-main">
          {artifact && <GraphCanvas />}
          <ViewSwitcher />
          {!artifact && !loading && (
            <EmptyState
              hasProjects={projects.length > 0}
              hasProject={Boolean(project)}
              bound={Boolean(project?.repositories.length)}
              analyzing={analyzing}
              progress={job?.progress ?? 0}
            />
          )}
          {loading && <div className="vo-overlay">正在加载图谱…</div>}
          {error && <div className="vo-overlay is-error">{error}</div>}
          <AgentConsole />
        </main>
        <DetailPanel />
      </div>
      <StatusBar />
      {analysisActivity && (
        <AnalysisActivityModal
          activity={analysisActivity}
          progress={job?.progress ?? 0}
          onClose={closeAnalysisActivity}
        />
      )}
      {documentViewer && (
        <GeneratedDocumentModal viewer={documentViewer} onClose={closeDocumentViewer} />
      )}
      <DingtalkSetupModal />
    </div>
  )
}

function AnalysisActivityModal({
  activity, progress, onClose
}: {
  activity: NonNullable<ReturnType<typeof useProject.getState>['analysisActivity']>
  progress: number
  onClose: () => void
}) {
  const done = activity.phase === 'completed' || activity.phase === 'failed'
  const effectiveProgress = activity.phase === 'completed' ? 100 : Math.max(4, progress)
  return (
    <div className="vo-modal-backdrop vo-analysis-backdrop">
      <div className="vo-modal vo-analysis-modal">
        <div className="vo-modal__surface">
          <div className="vo-modal__head">
            <span className={`vo-analysis-pulse is-${activity.phase}`}>◉</span>
            <span className="vo-modal__title">{activity.title}</span>
            <span className="vo-modal__step">
              {activity.source === 'webhook' ? 'GitHub Webhook' : '手动触发'}
            </span>
          </div>
          <div className="vo-modal__body">
            <p className="vo-analysis-note">{activity.note}</p>
            <div className="vo-progress"><i style={{ width: `${effectiveProgress}%` }} /></div>
            <div className="vo-analysis-meta">
              {activity.beforeSha && <code>base {activity.beforeSha.slice(0, 7)}</code>}
              {activity.headSha && <code>head {activity.headSha.slice(0, 7)}</code>}
              <span>{activity.phase === 'queued' ? 'Redis 排队中' : activity.phase === 'running' ? `${progress}%` : activity.phase}</span>
            </div>
            {activity.changedFiles && activity.changedFiles.length > 0 && (
              <div className="vo-analysis-diff">
                <div><span>CHANGED FILES</span><b>+286</b><em>−19</em></div>
                {activity.changedFiles.map(file => <code key={file}>M&nbsp; {file}</code>)}
              </div>
            )}
          </div>
          {done && (
            <div className="vo-modal__foot">
              <button type="button" className="vo-chip is-accent" onClick={onClose}>查看最新结果</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function GeneratedDocumentModal({
  viewer, onClose
}: {
  viewer: NonNullable<ReturnType<typeof useProject.getState>['documentViewer']>
  onClose: () => void
}) {
  return (
    <div className="vo-modal-backdrop" onClick={onClose}>
      <div className="vo-docviewer" onClick={event => event.stopPropagation()}>
        <div className="vo-docviewer__head">
          <div>
            <strong>{viewer.title}</strong>
            <span>{viewer.updatedAt ? `更新于 ${new Date(viewer.updatedAt).toLocaleString()}` : 'AI 生成文档'}</span>
          </div>
          <button type="button" className="vo-ghost-btn" onClick={onClose}>✕</button>
        </div>
        <div className="vo-docviewer__body">
          {viewer.loading ? '正在从云端加载文档…' : viewer.error ? viewer.error : <Markdown>{viewer.markdown}</Markdown>}
        </div>
      </div>
    </div>
  )
}

/** 无项目 / 未绑仓库 / 分析中 的引导态——避免空白画布让人不知所措 */
function EmptyState({
  hasProjects, hasProject, bound, analyzing, progress
}: {
  hasProjects: boolean; hasProject: boolean
  bound: boolean; analyzing: boolean; progress: number
}) {
  let title: string
  let hint: string
  if (analyzing) {
    title = `正在分析仓库 · ${progress}%`
    hint = '克隆与确定性扫描进行中，完成后图谱会自动加载。'
  } else if (!hasProjects) {
    title = '还没有项目'
    hint = '点顶部项目下拉 → 「＋ 新建项目并连接仓库」开始。'
  } else if (!hasProject) {
    title = '未选择项目'
    hint = '从顶部下拉选一个项目。'
  } else if (!bound) {
    title = '该项目尚未绑定仓库'
    hint = '点顶栏「未绑定仓库 · 点击连接」填入 GitHub 仓库地址。'
  } else {
    title = '尚未生成图谱'
    hint = '点右上「触发分析」开始首次全量分析。'
  }

  return (
    <div className="vo-empty-state">
      <div className="vo-empty-state__icon">{analyzing ? '◐' : '◎'}</div>
      <div className="vo-empty-state__title">{title}</div>
      <p>{hint}</p>
      {analyzing && (
        <div className="vo-progress"><i style={{ width: `${Math.max(4, progress)}%` }} /></div>
      )}
    </div>
  )
}
