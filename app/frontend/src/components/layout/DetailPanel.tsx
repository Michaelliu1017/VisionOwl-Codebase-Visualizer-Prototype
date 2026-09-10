import { useEffect, useMemo, useState } from 'react'
import type { DocumentLink, Evidence } from '../../api/types'
import { useGraphView } from '../../stores/graph'
import { useProject } from '../../stores/project'
import { CollaborationPanel } from './CollaborationPanel'
import { WorkspaceActions } from './TopBar'

type Tab = 'overview' | 'evidence' | 'docs' | 'annotations'

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: '概览' },
  { id: 'evidence', label: '证据' },
  { id: 'docs', label: '文档' },
  { id: 'annotations', label: '批注' }
]

export function DetailPanel() {
  const artifact = useProject(s => s.artifact)
  const adjacency = useProject(s => s.adjacency)
  const documents = useProject(s => s.documents)
  const annotations = useProject(s => s.annotations)
  const graphVersion = useProject(s => s.graphVersion)
  const createDocument = useProject(s => s.createDocument)
  const deleteDocument = useProject(s => s.deleteDocument)
  const createAnnotation = useProject(s => s.createAnnotation)
  const deleteAnnotation = useProject(s => s.deleteAnnotation)
  const selectedNodeId = useGraphView(s => s.selectedNodeId)
  const selectNode = useGraphView(s => s.selectNode)
  const [tab, setTab] = useState<Tab>('overview')
  const [docForm, setDocForm] = useState(false)
  const [docTitle, setDocTitle] = useState('')
  const [docUrl, setDocUrl] = useState('')
  const [annBody, setAnnBody] = useState('')
  const [busy, setBusy] = useState(false)

  const node = useMemo(
    () => artifact?.nodes.find(n => n.id === selectedNodeId),
    [artifact, selectedNodeId]
  )
  const importantInternals = useMemo(() => {
    if (!artifact || !node) return []
    const orderedIds = node.architecture?.memberNodeIds ?? []
    const candidates = orderedIds.length > 0
      ? orderedIds.map(id => artifact.nodes.find(candidate => candidate.id === id)).filter(Boolean)
      : artifact.nodes.filter(candidate => candidate.parentId === node.id)
    return candidates.slice(0, 8) as typeof artifact.nodes
  }, [artifact, node])

  // 切换选中节点时回到概览,避免停留在上一节点的空 tab 造成“没有数据”的错觉
  useEffect(() => {
    setTab('overview')
    setDocForm(false)
  }, [selectedNodeId])

  if (!artifact) return <aside className="vo-detail"><WorkspaceActions /><CollaborationPanel /></aside>

  // 未选中:项目级概览
  if (!node) {
    const globalDocs = documents.filter(d => d.scope === 'global')
    return (
      <aside className="vo-detail">
        <WorkspaceActions />
        <CollaborationPanel />
        <div className="vo-panel-title"><span>详情</span></div>
        <div className="vo-detail__empty">
          <div className="vo-detail__empty-title">未选中模块</div>
          <p>点击图谱或左侧树中的任一节点,查看职责、证据、文档与批注。</p>
          <div className="vo-kv"><span>节点</span><code>{artifact.stats.nodeCount}</code></div>
          <div className="vo-kv"><span>关系</span><code>{artifact.stats.edgeCount}</code></div>
          <div className="vo-kv"><span>推断关系</span><code>{artifact.stats.inferredCount}</code></div>
          {artifact.architectureProjection?.sourceNodeCount != null && (
            <div className="vo-kv">
              <span>事实索引节点</span>
              <code>{artifact.architectureProjection.sourceNodeCount}</code>
            </div>
          )}
          <div className="vo-kv"><span>图谱版本</span><code>v{graphVersion?.versionNo} · {graphVersion?.commitSha}</code></div>
          {globalDocs.length > 0 && (
            <>
              <div className="vo-side-section__title" style={{ marginTop: 18 }}>全局文档</div>
              {globalDocs.map(d => <DocRow key={d.id} doc={d} />)}
            </>
          )}
        </div>
      </aside>
    )
  }

  const inbound = artifact.edges.filter(e => e.target === node.id)
  const outbound = artifact.edges.filter(e => e.source === node.id)
  const nameOf = (id: string) => artifact.nodes.find(n => n.id === id)?.name ?? id
  const nodeDocs = documents.filter(d => d.nodeId === node.id)
  const nodeAnns = annotations.filter(a => a.targetId === node.id)

  const submitDoc = async () => {
    if (!docTitle.trim() || !docUrl.trim() || busy) return
    setBusy(true)
    try {
      await createDocument({ nodeId: node.id, title: docTitle.trim(), url: docUrl.trim() })
      setDocTitle('')
      setDocUrl('')
      setDocForm(false)
    } finally {
      setBusy(false)
    }
  }

  const submitAnn = async () => {
    if (!annBody.trim() || busy) return
    setBusy(true)
    try {
      await createAnnotation({ targetId: node.id, body: annBody.trim() })
      setAnnBody('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="vo-detail">
      <WorkspaceActions />
      <CollaborationPanel />
      <div className="vo-detail__head">
        <div className="vo-detail__name">{node.name}</div>
        <div className="vo-detail__path">{node.path ?? node.kind}</div>
        <div className="vo-detail__badges">
          <span className="vo-badge">{node.kind}</span>
          <span className="vo-badge">{node.domain}</span>
          {node.inferred && <span className="vo-badge is-amber">推断</span>}
        </div>
      </div>

      <div className="vo-detail__tabs">
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            className={`vo-chip${tab === t.id ? ' is-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === 'docs' && nodeDocs.length > 0 && ` ${nodeDocs.length}`}
            {t.id === 'annotations' && nodeAnns.length > 0 && ` ${nodeAnns.length}`}
          </button>
        ))}
      </div>

      <div className="vo-detail__body">
        {tab === 'overview' && (
          <>
            <div className="vo-section-label">模块职责(AI)</div>
            <p className="vo-summary">{node.summary}</p>
            <div className="vo-kv"><span>直接依赖</span><code>{outbound.length}</code></div>
            <div className="vo-kv"><span>被依赖</span><code>{inbound.length}</code></div>
            <div className="vo-kv"><span>邻接节点</span><code>{adjacency.get(node.id)?.nodeIds.size ?? 0}</code></div>

            {importantInternals.length > 0 && (
              <>
                <div className="vo-section-label">重要内部组件 ({importantInternals.length})</div>
                <div className="vo-internals">
                  {importantInternals.map(internal => (
                    <div key={internal.id} className="vo-internal">
                      <div className="vo-internal__head">
                        <strong>{internal.name}</strong>
                        <span>{internal.kind}</span>
                      </div>
                      <p>{internal.summary || '承担该模块中的关键实现职责'}</p>
                      {internal.evidence?.[0]?.file && <code>{internal.evidence[0].file}</code>}
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="vo-section-label">调用 / 依赖 →</div>
            {outbound.length === 0 && <div className="vo-empty-line">无</div>}
            {outbound.map(e => (
              <button key={e.id} type="button" className="vo-rel" onClick={() => selectNode(e.target)}>
                <i className={`vo-rel__arrow${e.inferred ? ' is-amber' : ''}`}>→</i>
                <span>{nameOf(e.target)}</span>
                <em>{e.type}{e.inferred ? ' · 推断' : ''}</em>
              </button>
            ))}

            <div className="vo-section-label">← 被调用 / 被依赖</div>
            {inbound.length === 0 && <div className="vo-empty-line">无</div>}
            {inbound.map(e => (
              <button key={e.id} type="button" className="vo-rel" onClick={() => selectNode(e.source)}>
                <i className={`vo-rel__arrow${e.inferred ? ' is-amber' : ''}`}>←</i>
                <span>{nameOf(e.source)}</span>
                <em>{e.type}{e.inferred ? ' · 推断' : ''}</em>
              </button>
            ))}

            {nodeAnns.length > 0 && (
              <>
                <div className="vo-section-label">批注 ({nodeAnns.length})</div>
                {nodeAnns.slice(0, 2).map(a => (
                  <div key={a.id} className="vo-annotation">
                    <p>{a.body}</p>
                    <span>@{a.author.name} · {a.createdAt.slice(0, 10)}</span>
                  </div>
                ))}
                {nodeAnns.length > 2 && (
                  <button type="button" className="vo-chip" onClick={() => setTab('annotations')}>
                    查看全部 {nodeAnns.length} 条 →
                  </button>
                )}
              </>
            )}
          </>
        )}

        {tab === 'evidence' && (
          <>
            <div className="vo-section-label">代码证据</div>
            {node.evidence.length === 0 && <div className="vo-empty-line">该节点为推断结论,暂无代码证据</div>}
            {node.evidence.map((ev, i) => <EvidenceRow key={i} ev={ev} />)}
            <div className="vo-section-label">关系证据</div>
            {[...outbound, ...inbound].filter(e => e.evidence.length > 0).map(e => (
              <div key={e.id} className="vo-evidence-group">
                <div className="vo-evidence-group__title">{nameOf(e.source)} → {nameOf(e.target)}</div>
                {e.evidence.map((ev, i) => <EvidenceRow key={i} ev={ev} />)}
              </div>
            ))}
          </>
        )}

        {tab === 'docs' && (
          <>
            <div className="vo-section-label">挂载文档</div>
            {nodeDocs.length === 0 && !docForm && <div className="vo-empty-line">未挂载文档</div>}
            {nodeDocs.map(d => (
              <DocRow
                key={d.id}
                doc={d}
                onDelete={() => { void deleteDocument(d.id) }}
              />
            ))}
            {docForm ? (
              <div className="vo-form">
                <input
                  value={docTitle}
                  onChange={e => setDocTitle(e.target.value)}
                  placeholder="文档标题"
                  autoFocus
                />
                <input
                  value={docUrl}
                  onChange={e => setDocUrl(e.target.value)}
                  placeholder="钉钉文档链接 https://alidocs.dingtalk.com/…"
                />
                <div className="vo-form__acts">
                  <button type="button" className="vo-chip is-accent" disabled={busy} onClick={() => { void submitDoc() }}>
                    {busy ? '挂载中…' : '确认挂载'}
                  </button>
                  <button type="button" className="vo-chip" onClick={() => setDocForm(false)}>取消</button>
                </div>
              </div>
            ) : (
              <button type="button" className="vo-add-btn" onClick={() => setDocForm(true)}>
                ＋ 挂载钉钉文档
              </button>
            )}
          </>
        )}

        {tab === 'annotations' && (
          <>
            <div className="vo-section-label">团队批注</div>
            {nodeAnns.length === 0 && <div className="vo-empty-line">暂无批注</div>}
            {nodeAnns.map(a => (
              <div key={a.id} className="vo-annotation">
                <p>{a.body}</p>
                <div className="vo-annotation__meta">
                  <span>@{a.author.name} · {a.createdAt.slice(0, 10)}</span>
                  <button
                    type="button"
                    className="vo-del-btn"
                    title="删除批注"
                    onClick={() => { void deleteAnnotation(a.id) }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
            <div className="vo-form">
              <textarea
                value={annBody}
                onChange={e => setAnnBody(e.target.value)}
                placeholder="对该模块补充说明…(Enter 发送)"
                rows={2}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void submitAnn()
                  }
                }}
              />
              <div className="vo-form__acts">
                <button type="button" className="vo-chip is-accent" disabled={busy} onClick={() => { void submitAnn() }}>
                  {busy ? '提交中…' : '添加批注'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </aside>
  )
}

function EvidenceRow({ ev }: { ev: Evidence }) {
  return (
    <div className="vo-evidence" title={ev.file}>
      <code>
        {ev.file}:{ev.startLine}{ev.endLine ? `-${ev.endLine}` : ''}
      </code>
      {ev.symbol && <span>{ev.symbol}</span>}
    </div>
  )
}

function DocRow({ doc, onDelete }: {
  doc: DocumentLink; onDelete?: () => void
}) {
  const openDocument = useProject(s => s.openDocument)
  return (
    <div className="vo-doc">
      <button className="vo-doc__main" type="button" onClick={() => { void openDocument(doc) }}>
        <span className="vo-doc__icon">◎</span>
        <span className="vo-doc__title">{doc.title}</span>
        {doc.docType === 'generated' && <span className="vo-badge">AI 生成</span>}
        {doc.status === 'maybe_stale' && <span className="vo-badge is-amber">可能过期</span>}
        {doc.status === 'sync_failed' && <span className="vo-badge is-amber">钉钉同步失败</span>}
      </button>
      {onDelete && (
        <button type="button" className="vo-del-btn" title="移除挂载" onClick={onDelete}>✕</button>
      )}
    </div>
  )
}
