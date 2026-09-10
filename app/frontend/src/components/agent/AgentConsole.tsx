import { useEffect, useRef, useState } from 'react'
import { Markdown } from '../common/Markdown'
import { COMPACT_H, useAgent } from '../../stores/agent'
import { useGraphView } from '../../stores/graph'
import { useProject } from '../../stores/project'

/** 快捷指令:动作导向,点击即以当前选中模块为上下文提问 */
const QUICK_ACTIONS = [
  { label: '分析代码', prompt: '分析这个模块的代码实现与职责边界' },
  { label: '影响面', prompt: '修改这个模块会影响哪些组件?' },
  { label: '数据流转', prompt: '数据在这个模块里是怎么流转的?' },
  { label: '调用关系', prompt: '这个模块被谁调用,又调用了谁?' },
  { label: '过期文档', prompt: '与这个模块相关的文档哪些可能已经过期?' }
]

const MIN_H = COMPACT_H

/**
 * Agent 玻璃控制台:
 *   顶部一行 = 快捷指令 + 右上角绿色缩放钮
 *   主体     = 深色对话框(内含消息滚动区 + 输入 + 右下发送钮),窗体变高时由它伸展
 * 三态:mini 36px ↔ 紧凑 180px ↔ 放大(≤60% 画布高)
 * ` 呼出/收起,⌘J 聚焦输入,Esc 清除高亮/选中。
 */
export function AgentConsole() {
  const mode = useAgent(s => s.mode)
  const height = useAgent(s => s.height)
  const messages = useAgent(s => s.messages)
  const sending = useAgent(s => s.sending)
  const toggleMode = useAgent(s => s.toggleMode)
  const collapse = useAgent(s => s.collapse)
  const setHeight = useAgent(s => s.setHeight)
  const maximize = useAgent(s => s.maximize)
  const toggleSize = useAgent(s => s.toggleSize)
  const send = useAgent(s => s.send)

  const artifact = useProject(s => s.artifact)
  const documents = useProject(s => s.documents)
  const docgenTask = useProject(s => s.docgenTask)
  const selectedNodeId = useGraphView(s => s.selectedNodeId)
  const clearSelection = useGraphView(s => s.clearSelection)
  const setAiHighlight = useGraphView(s => s.setAiHighlight)

  const [draft, setDraft] = useState('')
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const dragMovedRef = useRef(false)
  const wasSendingRef = useRef(false)

  const selectedName = artifact?.nodes.find(n => n.id === selectedNodeId)?.name
  const selectedNode = artifact?.nodes.find(n => n.id === selectedNodeId)
  const hasLinkedDocument = documents.some(document => document.nodeId === selectedNodeId)
  const generatingDoc = docgenTask?.status === 'pending' || docgenTask?.status === 'running' || docgenTask?.status === 'ready_to_publish'
  const open = mode === 'open'
  const maximized = height > COMPACT_H + 24

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA'
      if (e.key === '`' && !typing) {
        e.preventDefault()
        toggleMode()
      } else if (e.key.toLowerCase() === 'j' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        useAgent.setState({ mode: 'open' })
        requestAnimationFrame(() => inputRef.current?.focus())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleMode])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  const availableH = () => rootRef.current?.parentElement?.clientHeight ?? 800

  useEffect(() => {
    const answerCompleted = wasSendingRef.current && !sending
    wasSendingRef.current = sending
    if (!answerCompleted) return

    maximize(availableH())
    requestAnimationFrame(() => {
      logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' })
    })
  }, [maximize, sending])

  const onDragStart = (e: React.PointerEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = height
    const maxH = Math.round(availableH() * 0.6)
    dragMovedRef.current = false
    setDragging(true)

    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientY - startY) > 4) dragMovedRef.current = true
      const h = startH + (startY - ev.clientY)
      setHeight(Math.min(maxH, Math.max(MIN_H, h)))
      if (h < COMPACT_H - 16) collapse()
    }
    const up = () => {
      setDragging(false)
      // 顶部横杆既是 resize handle，也是最直接的最小化入口。
      if (!dragMovedRef.current) collapse()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const submit = () => {
    if (!draft.trim() || sending) return
    void send(draft)
    setDraft('')
  }

  return (
    <div
      ref={rootRef}
      className={`vo-console ${open ? 'is-open' : 'is-mini'}${dragging ? ' is-dragging' : ''}`}
      style={{ height: open ? height : 36 }}
    >
      {/* mini 态 */}
      <button
        type="button"
        className="vo-console__minibar"
        onClick={toggleMode}
        tabIndex={open ? -1 : 0}
        aria-hidden={open}
      >
        <span className="vo-console__logo">◉</span>
        <span>Agent</span>
        {selectedName && <span className="vo-ctx-chip">◉ {selectedName}</span>}
        <span className="vo-console__hint">` 展开 · ⌘J 提问</span>
      </button>

      {/* 展开态 */}
      <div className="vo-console__panel" aria-hidden={!open}>
        <div
          className="vo-console__drag"
          onPointerDown={onDragStart}
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              collapse()
            }
          }}
          role="button"
          tabIndex={0}
          aria-label="最小化 Agent 面板"
          title="单击最小化，拖动调整高度"
        />

        {/* 顶部一行:快捷指令 + 缩放钮 */}
        <div className="vo-console__toolbar">
          <div className="vo-console__quick">
            {selectedName ? (
              <span className="vo-ctx-chip">
                ◉ {selectedName}
                <button type="button" onClick={clearSelection} aria-label="清除上下文">✕</button>
              </span>
            ) : (
              <span className="vo-ctx-chip is-empty">全局</span>
            )}
            {QUICK_ACTIONS.map(a => (
              <button
                key={a.label}
                type="button"
                className="vo-quick-btn"
                disabled={sending}
                onClick={() => { void send(a.prompt) }}
              >
                {a.label}
              </button>
            ))}
            <button
              type="button"
              className="vo-quick-btn"
              disabled={sending || generatingDoc || !selectedNodeId || selectedNode?.kind !== 'module'}
              title={selectedNode?.kind === 'module'
                ? '调用云端 Agent 分析当前模块，并通过本机 DWS 生成或覆盖钉钉文档'
                : '请先选择一个 module 节点'}
              onClick={() => {
                if (!selectedNodeId) return
                void send(hasLinkedDocument
                  ? '更新这个模块挂载的钉钉代码文档'
                  : '为这个模块生成并挂载钉钉代码文档')
              }}
            >
              {generatingDoc ? '文档更新中…' : hasLinkedDocument ? '更新文档' : '生成文档'}
            </button>
          </div>
          <button
            type="button"
            className="vo-zoom-btn"
            onClick={() => toggleSize(availableH())}
            title={maximized ? '还原' : '放大'}
            aria-label={maximized ? '还原' : '放大'}
          >
            {maximized ? '⤡' : '⤢'}
          </button>
        </div>

        {/* 深色对话框:主体,窗体变高时由它伸展 */}
        <div className={`vo-chatbox${messages.length > 0 ? ' has-msgs' : ''}`}>
          <div className="vo-chatbox__log" ref={logRef}>
            {messages.length === 0 ? (
              <div className="vo-chatbox__hint">
                {selectedName
                  ? `已选中 ${selectedName} · 提问会自动带上该模块上下文与代码证据`
                  : '选中一个模块后提问更精准,也可以直接问代码库的全局问题'}
              </div>
            ) : (
              messages.map(m => (
                <div key={m.id} className={`vo-msg is-${m.role}`}>
                  <div className="vo-msg__body">
                    {m.role === 'agent' && m.text ? <Markdown>{m.text}</Markdown> : m.text}
                    {m.streaming && !m.text && (
                      <div className="vo-msg__status">{m.status ?? '正在连接 Agent…'}</div>
                    )}
                    {m.evidence && m.evidence.length > 0 && (
                      <div className="vo-msg__evidence">
                        {m.evidence.map((ev, i) => (
                          <code key={i}>{ev.file}:{ev.startLine}</code>
                        ))}
                      </div>
                    )}
                    {(m.highlight || m.inferred) && (
                      <div className="vo-msg__acts">
                        {m.highlight && (
                          <button
                            type="button"
                            className="vo-chip is-accent"
                            onClick={() => setAiHighlight(m.highlight!)}
                          >
                            ◉ 在图上高亮
                          </button>
                        )}
                        {m.inferred && <span className="vo-badge is-amber">含推断 · 待人工确认</span>}
                      </div>
                    )}
                    {m.provider && (
                      <div className="vo-msg__provider">
                        {m.provider === 'qoder' ? 'Qoder 云端回答' : '规则引擎降级回答'}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="vo-chatbox__composer">
            <textarea
              ref={inputRef}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit()
                }
              }}
              placeholder={selectedName ? `询问 ${selectedName}…` : '询问代码库任何问题…'}
              rows={2}
              spellCheck={false}
            />
          </div>
          <button
            type="button"
            className="vo-send"
            onClick={submit}
            disabled={sending || !draft.trim()}
            title="发送 (Enter)"
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  )
}
