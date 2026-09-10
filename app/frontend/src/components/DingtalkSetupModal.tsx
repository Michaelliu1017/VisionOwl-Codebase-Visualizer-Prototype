import { useState } from 'react'
import type { DingtalkConnection } from '../api/types'
import { useDingtalk } from '../stores/dingtalk'

export function DingtalkSetupModal() {
  const open = useDingtalk(state => state.open)
  const connections = useDingtalk(state => state.connections)
  const busy = useDingtalk(state => state.busy)
  const authenticating = useDingtalk(state => state.authenticating)
  const error = useDingtalk(state => state.error)
  const close = useDingtalk(state => state.closeSettings)
  const startConnect = useDingtalk(state => state.startConnect)
  const select = useDingtalk(state => state.select)
  const saveDestination = useDingtalk(state => state.saveDestination)
  const remove = useDingtalk(state => state.remove)
  const configured = connections.some(connection => connection.status === 'active')
  if (!open) return null
  return (
    <div className="vo-modal-backdrop vo-dingtalk-backdrop">
      <div className="vo-dingtalk-modal">
        <div className="vo-dingtalk-head">
          <div>
            <span className="vo-dingtalk-logo">钉</span>
            <div>
              <strong>连接钉钉 DWS</strong>
              <p>AI 代码文档将使用你选择的钉钉身份创建并持续更新。</p>
            </div>
          </div>
          {configured && <button type="button" className="vo-ghost-btn" onClick={close}>✕</button>}
        </div>

        <div className="vo-dingtalk-body">
          {!configured && (
            <div className="vo-dingtalk-required">
              首次使用需要完成一次钉钉授权。DWS 会在系统浏览器打开钉钉扫码页，OAuth 回调和凭证都只留在本机。
            </div>
          )}

          {connections.map(connection => (
            <ConnectionCard
              key={connection.id}
              connection={connection}
              disabled={busy}
              onSelect={() => { void select(connection.id) }}
              onSave={(workspaceId, folderId) => { void saveDestination(connection.id, workspaceId, folderId) }}
              onRemove={() => { void remove(connection.id) }}
            />
          ))}

          {authenticating && (
            <div className="vo-dingtalk-auth">
              <span>钉钉登录页已在系统浏览器打开。请扫码确认，浏览器回调成功后此窗口会自动更新。</span>
            </div>
          )}
          {error && <div className="vo-login__error">{error}</div>}
        </div>

        <div className="vo-dingtalk-foot">
          <button type="button" className="vo-link-btn" disabled={busy} onClick={() => { void startConnect() }}>
            {authenticating ? '等待扫码授权…' : busy ? '处理中…' : connections.length > 0 ? '＋ 连接另一个钉钉身份' : '连接钉钉身份'}
          </button>
          {configured && <button type="button" className="vo-primary-btn" onClick={close}>完成</button>}
        </div>
      </div>
    </div>
  )
}

function ConnectionCard({
  connection, disabled, onSelect, onSave, onRemove
}: {
  connection: DingtalkConnection
  disabled: boolean
  onSelect: () => void
  onSave: (workspaceId: string, folderId: string) => void
  onRemove: () => void
}) {
  const [workspaceId, setWorkspaceId] = useState(connection.workspaceId ?? '')
  const [folderId, setFolderId] = useState(connection.folderId ?? '')
  return (
    <div className={`vo-dingtalk-card${connection.isDefault ? ' is-current' : ''}`}>
      <div className="vo-dingtalk-card__top">
        <button type="button" disabled={disabled} className="vo-dingtalk-identity" onClick={onSelect}>
          <i>{connection.isDefault ? '●' : '○'}</i>
          <span>
            <strong>{connection.userName || connection.userId}</strong>
            <small>{connection.corpName || connection.corpId}</small>
          </span>
        </button>
        <span className={`vo-badge ${connection.status === 'active' ? 'is-green' : 'is-amber'}`}>
          {connection.status === 'active' ? connection.isDefault ? '当前身份' : '已连接' : '需重新授权'}
        </span>
      </div>
      <div className="vo-dingtalk-destination">
        <label>
          <span>知识库 Workspace ID（可选）</span>
          <input value={workspaceId} onChange={event => setWorkspaceId(event.target.value)} placeholder="留空则创建到我的文档" />
        </label>
        <label>
          <span>文档文件夹 nodeId / URL（优先，可选）</span>
          <input value={folderId} onChange={event => setFolderId(event.target.value)} placeholder="https://alidocs.dingtalk.com/i/nodes/…" />
        </label>
      </div>
      <div className="vo-dingtalk-card__actions">
        <button type="button" className="vo-chip" disabled={disabled} onClick={() => onSave(workspaceId, folderId)}>保存文档位置</button>
        <button type="button" className="vo-ghost-btn is-danger" disabled={disabled} onClick={onRemove}>解绑</button>
      </div>
    </div>
  )
}
