import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import type { PublicBranch, PublicRepository, RepositoryBinding } from '../../api/types'
import { useProject } from '../../stores/project'

/** 新建/管理 Project 仓库集合，仓库确认完成后统一触发联合分析。 */
export function ProjectSetupModal({
  mode,
  projectId,
  onClose
}: {
  mode: 'create' | 'bind'
  projectId?: string
  onClose: () => void
}) {
  const currentProject = useProject(s => s.project)
  const createProject = useProject(s => s.createProject)
  const bindRepository = useProject(s => s.bindRepository)
  const removeRepository = useProject(s => s.removeRepository)
  const selectProject = useProject(s => s.selectProject)
  const triggerAnalysis = useProject(s => s.triggerAnalysis)

  const [step, setStep] = useState<'name' | 'repo' | 'analyze'>(mode === 'create' ? 'name' : 'repo')
  const [name, setName] = useState('')
  const [pid, setPid] = useState(projectId ?? '')
  const [repoUrl, setRepoUrl] = useState('')
  const [branch, setBranch] = useState('main')
  const [repository, setRepository] = useState<PublicRepository | null>(null)
  const [branches, setBranches] = useState<PublicBranch[]>([])
  const [boundRepositories, setBoundRepositories] = useState<RepositoryBinding[]>(
    currentProject && currentProject.id === projectId ? currentProject.repositories : []
  )
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const firstRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    firstRef.current?.focus()
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, step])

  useEffect(() => {
    if (mode === 'bind' && currentProject && currentProject.id === projectId) {
      setBoundRepositories(currentProject.repositories)
    }
  }, [currentProject, mode, projectId])

  const parsed = parseRepo(repoUrl)

  const resetCandidate = () => {
    setRepoUrl('')
    setBranch('main')
    setRepository(null)
    setBranches([])
  }

  const inspectRepo = async () => {
    if (!parsed || busy) return
    setBusy(true); setErr(null); setRepository(null); setBranches([])
    try {
      const [repo, branchItems] = await Promise.all([
        api.inspectPublicRepository(parsed),
        api.listPublicBranches(parsed)
      ])
      const defaultItem = branchItems.find(item => item.name === repo.defaultBranch)
        ?? { name: repo.defaultBranch, commitSha: '' }
      setRepository(repo)
      setBranches([defaultItem, ...branchItems.filter(item => item.name !== repo.defaultBranch)])
      setBranch(repo.defaultBranch)
    } catch (caught) {
      setErr(caught instanceof Error ? caught.message : '仓库检查失败')
    } finally {
      setBusy(false)
    }
  }

  const submitName = async () => {
    if (!name.trim() || busy) return
    setBusy(true); setErr(null)
    try {
      const id = await createProject(name.trim())
      setPid(id)
      setBoundRepositories([])
      setStep('repo')
    } catch (caught) {
      setErr(caught instanceof Error ? caught.message : '创建失败')
    } finally {
      setBusy(false)
    }
  }

  const addRepository = async () => {
    if (!repository || !branch.trim() || busy || !pid) return
    setBusy(true); setErr(null)
    try {
      const binding = await bindRepository(pid, {
        repoFullName: repository.fullName,
        branch: branch.trim()
      })
      setBoundRepositories(items => items.some(item => item.id === binding.id)
        ? items
        : [...items, binding])
      resetCandidate()
    } catch (caught) {
      setErr(caught instanceof Error ? caught.message : '绑定失败')
    } finally {
      setBusy(false)
    }
  }

  const deleteRepository = async (bindingId: string) => {
    if (!pid || busy) return
    setBusy(true); setErr(null)
    try {
      await removeRepository(pid, bindingId)
      setBoundRepositories(items => items.filter(item => item.id !== bindingId))
    } catch (caught) {
      setErr(caught instanceof Error ? caught.message : '移除仓库失败')
    } finally {
      setBusy(false)
    }
  }

  const finishRepositories = async () => {
    if (!pid || boundRepositories.length === 0 || busy) return
    setBusy(true); setErr(null)
    try {
      await selectProject(pid)
      setStep('analyze')
    } catch (caught) {
      setErr(caught instanceof Error ? caught.message : '读取仓库集合失败')
    } finally {
      setBusy(false)
    }
  }

  const submitAnalysis = async () => {
    if (busy) return
    setBusy(true); setErr(null)
    try {
      await triggerAnalysis()
      onClose()
    } catch (caught) {
      setErr(caught instanceof Error ? caught.message : '分析触发失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="vo-modal-backdrop" onClick={onClose}>
      <div className="vo-modal vo-repository-modal" onClick={event => event.stopPropagation()}>
        <div className="vo-modal__surface">
          <div className="vo-modal__head">
            <span className="vo-modal__title">
              {step === 'name' ? '新建项目' : step === 'repo' ? '管理代码仓库' : '开始联合分析'}
            </span>
            <span className="vo-modal__step">
              {mode === 'create'
                ? `${step === 'name' ? 1 : step === 'repo' ? 2 : 3} / 3`
                : step === 'repo' ? '1 / 2' : '2 / 2'}
            </span>
            <button type="button" className="vo-ghost-btn" onClick={onClose}>✕</button>
          </div>

          <div className="vo-modal__body">
            {step === 'name' ? (
              <>
                <label className="vo-field">
                  <span>项目名称</span>
                  <input
                    ref={firstRef}
                    value={name}
                    onChange={event => setName(event.target.value)}
                    onKeyDown={event => { if (event.key === 'Enter') void submitName() }}
                    placeholder="例如 commerce-platform"
                  />
                </label>
                <p className="vo-modal__hint">一个 Project 可以联合分析多个有关联的仓库与分支。</p>
              </>
            ) : step === 'repo' ? (
              <>
                {boundRepositories.length > 0 && (
                  <div className="vo-repository-list">
                    <div className="vo-repository-list__title">
                      <span>已加入联合分析</span><strong>{boundRepositories.length}</strong>
                    </div>
                    {boundRepositories.map(item => (
                      <div className="vo-repository-item" key={item.id}>
                        <span className="vo-repository-item__mark" />
                        <div>
                          <strong>{item.repoFullName}</strong>
                          <code>{item.branch}</code>
                        </div>
                        <button
                          type="button"
                          className="vo-ghost-btn"
                          disabled={busy}
                          title="移出当前 Project"
                          onClick={() => { void deleteRepository(item.id) }}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="vo-repository-candidate">
                  <label className="vo-field">
                    <span>继续添加 GitHub 仓库</span>
                    <input
                      ref={firstRef}
                      value={repoUrl}
                      onChange={event => {
                        setRepoUrl(event.target.value)
                        setRepository(null)
                        setBranches([])
                      }}
                      onKeyDown={event => { if (event.key === 'Enter') void inspectRepo() }}
                      placeholder="https://github.com/owner/repo 或 owner/repo"
                      spellCheck={false}
                    />
                  </label>
                  {repoUrl.trim() !== '' && (
                    <div className={`vo-parse-hint${parsed ? '' : ' is-bad'}`}>
                      {parsed ? `待验证 ${parsed}` : '无法解析，请填写 owner/repo 或完整 GitHub URL'}
                    </div>
                  )}
                  <div className="vo-repository-candidate__actions">
                    <button
                      type="button"
                      className="vo-chip"
                      disabled={busy || !parsed}
                      onClick={() => { void inspectRepo() }}
                    >
                      {busy ? '检查中…' : repository ? `已验证 ${repository.fullName}` : '检查仓库'}
                    </button>
                    <label className="vo-field vo-field--branch">
                      <span>目标分支</span>
                      <select
                        value={branch}
                        onChange={event => setBranch(event.target.value)}
                        disabled={!repository || branches.length === 0}
                      >
                        {branches.length === 0 && <option value="main">请先检查仓库</option>}
                        {branches.map(item => (
                          <option key={item.name} value={item.name}>
                            {item.name} · {item.commitSha ? item.commitSha.slice(0, 7) : '默认分支'}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      className="vo-chip is-accent"
                      disabled={busy || !repository || !branch.trim()}
                      onClick={() => { void addRepository() }}
                    >
                      添加
                    </button>
                  </div>
                </div>
                <p className="vo-modal__hint">
                  每个仓库会形成独立 Runner 子任务；全部成功后才发布一张联合图谱。
                </p>
              </>
            ) : (
              <div className="vo-ready-card">
                <strong>{boundRepositories.length} 个仓库已就绪</strong>
                <div className="vo-ready-repositories">
                  {boundRepositories.map(item => <code key={item.id}>{item.repoFullName} @ {item.branch}</code>)}
                </div>
                <p>Cloud API 将冻结各仓库 commit，Worker 并行扫描后再计算跨仓库调用关系。</p>
              </div>
            )}

            {err && <div className="vo-modal__error">{err}</div>}
          </div>

          <div className="vo-modal__foot">
            <button type="button" className="vo-chip" onClick={onClose}>取消</button>
            {step === 'name' ? (
              <button
                type="button"
                className="vo-chip is-accent"
                disabled={busy || !name.trim()}
                onClick={() => { void submitName() }}
              >
                {busy ? '创建中…' : '下一步'}
              </button>
            ) : step === 'repo' ? (
              <button
                type="button"
                className="vo-chip is-accent"
                disabled={busy || boundRepositories.length === 0}
                onClick={() => { void finishRepositories() }}
              >
                {busy ? '同步中…' : `分析这 ${boundRepositories.length} 个仓库`}
              </button>
            ) : (
              <button
                type="button"
                className="vo-chip is-accent"
                disabled={busy}
                onClick={() => { void submitAnalysis() }}
              >
                {busy ? '投递中…' : '开始联合分析'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function parseRepo(input: string): string | null {
  const normalized = input.trim().replace(/\.git$/i, '').replace(/\/+$/, '')
  const match = /^(?:https?:\/\/(?:www\.)?github\.com\/)?([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/.exec(normalized)
  return match?.[1] ?? null
}
