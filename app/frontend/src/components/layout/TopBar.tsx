import { useEffect, useRef, useState } from 'react'
import type { Job } from '../../api/types'
import { useDingtalk } from '../../stores/dingtalk'
import { useGraphView } from '../../stores/graph'
import { useProject } from '../../stores/project'
import { useSession } from '../../stores/session'
import { ProjectSetupModal } from './ProjectSetupModal'

/** 左栏顶部承载品牌和仓库上下文，替代原先横跨全屏的顶栏。 */
export function ProjectSidebarHeader() {
  const projects = useProject(s => s.projects)
  const project = useProject(s => s.project)
  const artifact = useProject(s => s.artifact)
  const job = useProject(s => s.job)
  const selectProject = useProject(s => s.selectProject)
  const triggerAnalysis = useProject(s => s.triggerAnalysis)
  const [open, setOpen] = useState(false)
  const [confirmReanalysis, setConfirmReanalysis] = useState(false)
  const [modal, setModal] = useState<null | { mode: 'create' | 'bind'; projectId?: string }>(null)
  const ddRef = useRef<HTMLDivElement>(null)
  const busy = job?.status === 'queued' || job?.status === 'running'

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!ddRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (!confirmReanalysis) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConfirmReanalysis(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmReanalysis])

  return (
    <>
      <div className="vo-sidebar-header">
        <div className="vo-sidebar-brand">
          <img className="vo-logo" src="./hackowl-transparent.png" alt="VisionOwl" />
          <div>
            <strong className="vo-brand">VisionOwl</strong>
            <span>Code intelligence</span>
          </div>
        </div>

        <div className="vo-project-dd" ref={ddRef}>
          <button
            className="vo-project-pill"
            type="button"
            onClick={() => setOpen(value => !value)}
            title="切换项目"
          >
            <span>{project?.name ?? '选择项目'}</span>
            <span className="vo-caret">▾</span>
          </button>

          {open && (
            <div className="vo-dropdown">
              <div className="vo-dropdown__label">我的项目 ({projects.length})</div>
              {projects.length === 0 && <div className="vo-dropdown__empty">还没有项目,先新建一个</div>}
              {projects.map(item => (
                <button
                  key={item.id}
                  type="button"
                  className={`vo-dropdown__item${item.id === project?.id ? ' is-active' : ''}`}
                  onClick={() => { setOpen(false); void selectProject(item.id) }}
                >
                  <span className="vo-dropdown__name">{item.name}</span>
                  <span className="vo-dropdown__meta">
                    {item.repo
                      ? `${item.repo}${item.repositoryCount > 1 ? ` +${item.repositoryCount - 1}` : ''} @ ${item.branch}`
                      : '未绑定仓库'}
                  </span>
                  <span className="vo-dropdown__role">{item.myRole}</span>
                </button>
              ))}
              <div className="vo-dropdown__sep" />
              <button
                type="button"
                className="vo-dropdown__action"
                onClick={() => { setOpen(false); setModal({ mode: 'create' }) }}
              >
                ＋ 新建项目并连接仓库
              </button>
              {project && (
                <button
                  type="button"
                  className="vo-dropdown__action"
                  onClick={() => { setOpen(false); setModal({ mode: 'bind', projectId: project.id }) }}
                >
                  ⚯ 管理「{project.name}」的 {project.repositories.length} 个仓库
                </button>
              )}
            </div>
          )}
        </div>

        {project?.binding && project.repositories.length > 0 ? (
          <>
            <div className="vo-sidebar-repo">
              <span title={project.repositories.map(item => `${item.repoFullName} @ ${item.branch}`).join('\n')}>
                {project.binding.repoFullName}
                {project.repositories.length > 1 && (
                  <b className="vo-sidebar-repo__count">+{project.repositories.length - 1}</b>
                )}
              </span>
              <code>{project.binding.branch}</code>
              {project.binding.currentCommitSha && <code>{project.binding.currentCommitSha.slice(0, 7)}</code>}
            </div>
            <button
              type="button"
              className="vo-reanalyze-btn"
              disabled={busy}
              title={artifact ? '强制重新分析当前 Project 的全部仓库' : '开始联合分析全部仓库'}
              onClick={() => {
                if (artifact) setConfirmReanalysis(true)
                else void triggerAnalysis(false)
              }}
            >
              <span className={`vo-reanalyze-btn__icon${busy ? ' is-spinning' : ''}`}>↻</span>
              <span>{busy ? `分析中 ${job?.progress ?? 0}%` : artifact ? '重新分析' : '开始分析'}</span>
            </button>
          </>
        ) : project ? (
          <button
            type="button"
            className="vo-link-btn"
            onClick={() => setModal({ mode: 'bind', projectId: project.id })}
          >
            未绑定仓库 · 点击连接
          </button>
        ) : null}
      </div>

      {modal && (
        <ProjectSetupModal
          mode={modal.mode}
          projectId={modal.projectId}
          onClose={() => setModal(null)}
        />
      )}

      {confirmReanalysis && project?.binding && project.repositories.length > 0 && (
        <div className="vo-modal-backdrop" onClick={() => setConfirmReanalysis(false)}>
          <div className="vo-modal vo-reanalysis-modal" onClick={event => event.stopPropagation()}>
            <div className="vo-modal__surface">
              <div className="vo-modal__head">
                <span className="vo-modal__title">重新联合分析代码架构</span>
                <span className="vo-modal__step">{project.repositories.length} 个仓库</span>
              </div>
              <div className="vo-modal__body">
                <p className="vo-modal__hint">
                  将冻结每个仓库的目标 commit，并行扫描后生成新的联合图谱版本。旧图谱会保留到全部子任务与跨仓关系校验成功。
                </p>
                <div className="vo-reanalysis-summary">
                  {project.repositories.map(repository => (
                    <div key={repository.id}>
                      <span>{repository.isPrimary ? '主仓库' : '关联仓库'}</span>
                      <code>
                        {repository.repoFullName} @ {repository.branch}
                        {repository.currentCommitSha ? ` · ${repository.currentCommitSha.slice(0, 8)}` : ''}
                      </code>
                    </div>
                  ))}
                </div>
              </div>
              <div className="vo-modal__foot">
                <button type="button" className="vo-chip" onClick={() => setConfirmReanalysis(false)}>取消</button>
                <button
                  type="button"
                  className="vo-chip is-accent"
                  onClick={() => {
                    setConfirmReanalysis(false)
                    void triggerAnalysis(true)
                  }}
                >
                  确认重新分析
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/** 画布中央的紧凑玻璃视图切换器。 */
export function ViewSwitcher() {
  const artifact = useProject(s => s.artifact)
  const activeViewId = useGraphView(s => s.activeViewId)
  const setActiveView = useGraphView(s => s.setActiveView)

  if (!artifact || artifact.views.length === 0) return null
  const viewPriority = (view: (typeof artifact.views)[number]): number => {
    if (view.name.includes('总体架构')) return 0
    if (view.id === 'project:overview' || view.id === 'overview') return 1
    if (view.id.startsWith('flow:')) return 2
    return 3
  }
  const orderedViews = [...artifact.views].sort((left, right) =>
    viewPriority(left) - viewPriority(right)
  )
  return (
    <nav className="vo-viewbar" aria-label="图谱视图">
      <span className="vo-viewbar__mark">◫</span>
      <div className="vo-viewbar__buttons">
        {orderedViews.map(view => (
          <button
            key={view.id}
            type="button"
            className={`vo-tab${view.id === activeViewId ? ' is-active' : ''}`}
            onClick={() => setActiveView(view.id)}
          >
            {view.name}
          </button>
        ))}
      </div>
    </nav>
  )
}

/** 右栏顶部聚合分析状态、搜索、发布入口与账户工具。 */
export function WorkspaceActions() {
  const artifact = useProject(s => s.artifact)
  const job = useProject(s => s.job)

  return (
    <div className="vo-workspace-actions">
      <div className="vo-workspace-actions__status">
        <JobStatus job={job} hasGraph={Boolean(artifact)} />
        <DingtalkBadge />
        <UserBadge />
      </div>
      <div className="vo-workspace-actions__commands">
        <div className="vo-search" role="button" tabIndex={0}>⌘K 搜索节点 / 文档…</div>
      </div>
    </div>
  )
}

function DingtalkBadge() {
  const connection = useDingtalk(state => state.connections.find(item => item.isDefault) ?? null)
  const openSettings = useDingtalk(state => state.openSettings)
  return (
    <button
      type="button"
      className={`vo-dingtalk-pill${connection?.status === 'active' ? ' is-connected' : ''}`}
      onClick={openSettings}
      title="钉钉身份与文档位置"
    >
      <span>钉</span>
      {connection ? connection.userName || connection.userId : '未连接'}
    </button>
  )
}

function JobStatus({ job, hasGraph }: { job: Job | null; hasGraph: boolean }) {
  if (job && (job.status === 'queued' || job.status === 'running')) {
    return (
      <span className="vo-status-pill is-busy">
        <i className="vo-dot" />
        {job.status === 'queued' ? '排队中' : `分析中 ${job.progress}%`}
      </span>
    )
  }
  if (job?.status === 'failed') {
    return <span className="vo-status-pill is-error"><i className="vo-dot is-error" />分析失败</span>
  }
  if (job?.status === 'succeeded') {
    return (
      <span className="vo-status-pill">
        <i className="vo-dot" />分析完成
        {job.credits !== null && job.credits > 0 && ` · ${job.credits.toFixed(1)} credits`}
      </span>
    )
  }
  return <span className="vo-status-pill"><i className="vo-dot" />{hasGraph ? '图谱就绪' : '等待分析'}</span>
}

function UserBadge() {
  const user = useSession(s => s.user)
  const logout = useSession(s => s.logout)
  const resetDingtalk = useDingtalk(s => s.reset)
  if (!user) return null
  return (
    <button
      className="vo-user"
      type="button"
      title={`${user.name} · 点击退出`}
      onClick={() => { resetDingtalk(); logout() }}
    >
      {user.name.slice(0, 1)}
    </button>
  )
}
