import { create } from 'zustand'
import { api } from '../api/client'
import type { Evidence } from '../api/types'
import { useGraphView } from './graph'
import { useProject } from './project'

export interface AgentMessage {
  id: string
  role: 'user' | 'agent'
  text: string
  evidence?: Evidence[]
  highlight?: { nodeIds: string[]; edgeIds: string[] }
  inferred?: boolean
  provider?: 'qoder' | 'rules'
  streaming?: boolean
  status?: string
}

/** 紧凑态默认高度；完整容纳快捷操作、上下文提示和两行输入。 */
export const COMPACT_H = 180

interface AgentState {
  /** 三态:mini(36px 迷你条) / open(紧凑或放大,由 height 决定) */
  mode: 'mini' | 'open'
  /** open 态窗体高度,px;紧凑态 COMPACT_H,放大态上限画布高 60% */
  height: number
  messages: AgentMessage[]
  sessions: Record<string, string>
  sending: boolean

  toggleMode: () => void
  collapse: () => void
  setHeight: (h: number) => void
  /** 将面板展开到画布允许的最大高度。 */
  maximize: (availableH: number) => void
  /** 缩放按钮:紧凑 ↔ 放大 */
  toggleSize: (availableH: number) => void
  send: (question: string) => Promise<void>
}

let seq = 0
const nextId = () => `m-${Date.now()}-${seq++}`

/**
 * 文档写入必须走 Docgen + 本机 DWS，不能交给只读源码问答 Runner。
 * 疑问句仍按普通问答处理，避免“为什么不能修改文档”误触发覆盖操作。
 */
export function isDocumentWriteRequest(question: string): boolean {
  const q = question.trim().toLowerCase()
  const mentionsDocument = /(文档|钉钉|alidocs|wiki)/i.test(q)
  const requestsWrite = /(更新|修改|重写|同步|刷新|维护|覆盖|写入|生成)/i.test(q)
  const asksAboutCapability = /(为什么|为何|怎么|如何|能否|是否|可不可以|可以吗|能不能)/i.test(q)
  return mentionsDocument && requestsWrite && !asksAboutCapability
}

export const useAgent = create<AgentState>((set, get) => ({
  mode: 'open',
  height: COMPACT_H,
  messages: [],
  sessions: {},
  sending: false,

  toggleMode() {
    set(s => ({ mode: s.mode === 'mini' ? 'open' : 'mini' }))
  },

  collapse() {
    set({ mode: 'mini' })
  },

  setHeight(h) {
    set({ height: h })
  },

  maximize(availableH) {
    set({
      mode: 'open',
      height: Math.max(COMPACT_H + 40, Math.round(availableH * 0.6))
    })
  },

  toggleSize(availableH) {
    const maxH = Math.round(availableH * 0.6)
    set(s => ({
      mode: 'open',
      // 靠近紧凑态 → 放大;已放大 → 回紧凑
      height: s.height > COMPACT_H + 24 ? COMPACT_H : Math.max(COMPACT_H + 40, maxH)
    }))
  },

  async send(question) {
    const q = question.trim()
    if (!q || get().sending) return

    const project = useProject.getState().project
    if (!project) return
    const nodeId = useGraphView.getState().selectedNodeId ?? null

    const userMsg: AgentMessage = { id: nextId(), role: 'user', text: q }
    const agentMsg: AgentMessage = { id: nextId(), role: 'agent', text: '', streaming: true }
    set(s => ({ messages: [...s.messages, userMsg, agentMsg], sending: true, mode: 'open' }))

    const patch = (p: Partial<AgentMessage>) =>
      set(s => ({
        messages: s.messages.map(m => (m.id === agentMsg.id ? { ...m, ...p } : m))
      }))

    if (isDocumentWriteRequest(q)) {
      const projectState = useProject.getState()
      const node = projectState.artifact?.nodes.find(item => item.id === nodeId)
      if (!nodeId || !node || node.kind !== 'module') {
        patch({
          text: '更新代码文档前，请先在图谱中选中一个模块。文档写入只会作用于当前明确选中的模块。',
          streaming: false
        })
        set({ sending: false })
        return
      }

      patch({ status: `正在分析 ${node.name} 并准备更新挂载的钉钉文档…` })
      try {
        await projectState.generateDocument(nodeId)
        const latest = useProject.getState()
        const task = latest.docgenTask
        const document = task?.docId
          ? latest.documents.find(item => item.id === task.docId)
          : latest.documents.find(item => item.nodeId === nodeId)

        if (task?.status === 'succeeded') {
          patch({
            text: document
              ? `已完成：Agent 已按当前代码重新分析 **${node.name}**，并通过本机 DWS 更新挂载文档《${document.title}》。`
              : `已完成：Agent 已按当前代码重新分析 **${node.name}**，文档已发布。`,
            streaming: false,
            status: undefined
          })
        } else if (task?.status === 'failed') {
          patch({
            text: `文档更新失败：${task.error ?? '未取得可发布的文档内容'}`,
            streaming: false,
            status: undefined
          })
        } else {
          patch({
            text: '文档更新需要先完成钉钉身份授权。我已经打开身份设置，授权完成后请再次发送更新指令。',
            streaming: false,
            status: undefined
          })
        }
      } catch (error) {
        patch({
          text: `文档更新失败：${error instanceof Error ? error.message : String(error)}`,
          streaming: false,
          status: undefined
        })
      } finally {
        set({ sending: false })
      }
      return
    }

    try {
      for await (const ev of api.chat(project.id, q, nodeId, get().sessions[project.id] ?? null)) {
        if (ev.type === 'chat.meta') {
          set(state => ({ sessions: { ...state.sessions, [project.id]: ev.sessionId } }))
        } else if (ev.type === 'chat.status') {
          patch({ status: ev.note })
        } else if (ev.type === 'chat.delta') {
          set(s => ({
            messages: s.messages.map(m =>
              m.id === agentMsg.id ? { ...m, text: m.text + ev.text, status: undefined } : m
            )
          }))
        } else if (ev.type === 'chat.evidence') {
          patch({ evidence: ev.items })
        } else if (ev.type === 'chat.action' && ev.action === 'highlight') {
          patch({ highlight: { nodeIds: ev.nodeIds, edgeIds: ev.edgeIds } })
          useGraphView.getState().setAiHighlight({ nodeIds: ev.nodeIds, edgeIds: ev.edgeIds })
        } else if (ev.type === 'chat.done') {
          set(state => ({ sessions: { ...state.sessions, [project.id]: ev.sessionId } }))
          patch({ inferred: ev.inferred, provider: ev.provider, streaming: false, status: undefined })
        } else if (ev.type === 'chat.error') {
          patch({ text: `出错了：${ev.message}`, streaming: false, status: undefined })
        }
      }
    } catch (e) {
      patch({ text: e instanceof Error ? e.message : '对话失败', streaming: false, status: undefined })
    } finally {
      patch({ streaming: false, status: undefined })
      set({ sending: false })
    }
  }
}))
