import { useEffect, useState } from 'react'
import type { InvitationCreated } from '../../api/types'
import { useProject } from '../../stores/project'

type Dialog = 'invite' | 'join' | 'delete' | null

export function CollaborationPanel() {
  const project = useProject(state => state.project)
  const createInvitation = useProject(state => state.createInvitation)
  const joinProject = useProject(state => state.joinProject)
  const deleteCurrentProject = useProject(state => state.deleteCurrentProject)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [invitation, setInvitation] = useState<InvitationCreated | null>(null)
  const [inviteKey, setInviteKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDialog(null)
    setInvitation(null)
    setInviteKey('')
    setError(null)
  }, [project?.id])

  if (!project) return null

  const repoName = project.repositories.length > 1
    ? `${project.binding?.repoFullName ?? project.name} 等 ${project.repositories.length} 个仓库`
    : project.binding?.repoFullName ?? project.name
  const roleLabel = project.myRole === 'owner' ? 'Owner' : 'Editor'

  const openInvite = async () => {
    setDialog('invite')
    setInvitation(null)
    setCopied(false)
    setError(null)
    setBusy(true)
    try {
      setInvitation(await createInvitation())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '邀请码生成失败')
    } finally {
      setBusy(false)
    }
  }

  const submitJoin = async () => {
    if (!inviteKey.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await joinProject(inviteKey)
      setDialog(null)
      setInviteKey('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '加入 Project 失败')
    } finally {
      setBusy(false)
    }
  }

  const copyInvitation = async () => {
    if (!invitation) return
    try {
      await navigator.clipboard.writeText(invitation.key)
      setCopied(true)
    } catch {
      setError('复制失败，请手动选择邀请码')
    }
  }

  const submitDelete = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await deleteCurrentProject()
      setDialog(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '删除 Project 失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <section className="vo-collab" aria-label="Project 协作">
        <div className="vo-collab__context">
          <div>
            <span>团队 Project</span>
            <strong title={repoName}>{repoName}</strong>
          </div>
          <em>{roleLabel}</em>
        </div>
        <div className="vo-collab__actions">
          {project.myRole === 'owner' && (
            <button type="button" className="vo-collab-btn is-primary" onClick={() => { void openInvite() }}>
              邀请别人
            </button>
          )}
          <button
            type="button"
            className="vo-collab-btn"
            onClick={() => { setDialog('join'); setInviteKey(''); setError(null) }}
          >
            加入别人
          </button>
        </div>
        {project.myRole === 'owner' && (
          <button
            type="button"
            className="vo-collab__delete"
            onClick={() => { setDialog('delete'); setError(null) }}
          >
            删除 Project
          </button>
        )}
      </section>

      {dialog && (
        <div className="vo-modal-backdrop" onClick={() => { if (!busy) setDialog(null) }}>
          <div className="vo-modal vo-collab-modal" onClick={event => event.stopPropagation()}>
            <div className="vo-modal__surface">
              <div className="vo-modal__head">
                <div>
                  <div className="vo-modal__title">
                    {dialog === 'invite' ? '邀请加入 Project' : dialog === 'join' ? '加入团队 Project' : '删除 Project'}
                  </div>
                  <div className="vo-collab-modal__repo">{repoName}</div>
                </div>
                <button
                  type="button"
                  className="vo-collab-modal__close"
                  title="关闭"
                  disabled={busy}
                  onClick={() => setDialog(null)}
                >
                  ×
                </button>
              </div>

              {dialog === 'invite' && (
                <div className="vo-modal__body">
                  <p className="vo-modal__hint">邀请码永久有效、不限人数；加入者获得 Editor 权限。</p>
                  {busy && <div className="vo-collab-modal__loading"><i className="vo-dot" />正在生成邀请码…</div>}
                  {invitation && (
                    <div className="vo-invite-code">
                      <span>邀请码</span>
                      <code>{invitation.key}</code>
                    </div>
                  )}
                  {error && <div className="vo-modal__error">{error}</div>}
                </div>
              )}

              {dialog === 'join' && (
                <div className="vo-modal__body">
                  <p className="vo-modal__hint">输入团队成员分享的邀请码，即可加载该 Project 的图谱、文档和批注。</p>
                  <label className="vo-field">
                    <span>邀请码</span>
                    <input
                      value={inviteKey}
                      onChange={event => setInviteKey(event.target.value)}
                      placeholder="vo-inv-…"
                      autoFocus
                      onKeyDown={event => {
                        if (event.key === 'Enter') void submitJoin()
                      }}
                    />
                  </label>
                  {error && <div className="vo-modal__error">{error}</div>}
                </div>
              )}

              {dialog === 'delete' && (
                <div className="vo-modal__body">
                  <div className="vo-collab-danger">
                    <strong>删除后无法恢复</strong>
                    <p>图谱版本、文档挂载、批注、成员关系和邀请码都会一并删除。</p>
                  </div>
                  {error && <div className="vo-modal__error">{error}</div>}
                </div>
              )}

              <div className="vo-modal__foot">
                <button type="button" className="vo-chip" disabled={busy} onClick={() => setDialog(null)}>取消</button>
                {dialog === 'invite' && invitation && (
                  <button type="button" className="vo-chip is-accent" onClick={() => { void copyInvitation() }}>
                    {copied ? '已复制' : '复制邀请码'}
                  </button>
                )}
                {dialog === 'join' && (
                  <button
                    type="button"
                    className="vo-chip is-accent"
                    disabled={busy || !inviteKey.trim()}
                    onClick={() => { void submitJoin() }}
                  >
                    {busy ? '正在加入…' : '加入 Project'}
                  </button>
                )}
                {dialog === 'delete' && (
                  <button type="button" className="vo-chip is-danger" disabled={busy} onClick={() => { void submitDelete() }}>
                    {busy ? '正在删除…' : '确认删除'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
