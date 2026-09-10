import { create } from 'zustand'
import type { GraphNode } from '../api/types'

/**
 * 图谱视图状态 —— 单一权威状态(交互契约 §5.5 第 1 条)。
 * 邻接高亮/边强调/压暗集合一律由 selectedNodeId + adjacency 派生,
 * 本 store 不保存任何派生结果。
 */

export interface AiHighlight {
  nodeIds: string[]
  edgeIds: string[]
}

interface PendingModuleAttention {
  nodeId: string
  versionNo: number
  token: string
}

interface ModuleAttentionSnapshot {
  pending: PendingModuleAttention[]
  acknowledgedTokens: string[]
}

const MODULE_ATTENTION_KEY = 'visionowl.module-attention.v1'

function attentionKey(projectId: string): string {
  return `${MODULE_ATTENTION_KEY}:${projectId}`
}

function attentionToken(versionNo: number, nodeId: string): string {
  return `${versionNo}:${nodeId}`
}

function readAttention(projectId: string): ModuleAttentionSnapshot {
  try {
    const parsed = JSON.parse(localStorage.getItem(attentionKey(projectId)) ?? '{}') as Partial<ModuleAttentionSnapshot>
    return {
      pending: Array.isArray(parsed.pending)
        ? parsed.pending.filter(item =>
            item && typeof item.nodeId === 'string' &&
            typeof item.versionNo === 'number' && typeof item.token === 'string')
        : [],
      acknowledgedTokens: Array.isArray(parsed.acknowledgedTokens)
        ? parsed.acknowledgedTokens.filter(token => typeof token === 'string')
        : []
    }
  } catch {
    return { pending: [], acknowledgedTokens: [] }
  }
}

function writeAttention(projectId: string, snapshot: ModuleAttentionSnapshot): void {
  try {
    localStorage.setItem(attentionKey(projectId), JSON.stringify(snapshot))
  } catch {
    // localStorage 不可用时保留本次会话内状态，不阻断图谱交互。
  }
}

interface GraphViewState {
  selectedNodeId: string | undefined
  hoveredNodeId: string | undefined
  aiHighlight: AiHighlight | null
  newModuleProjectId: string | null
  newModuleIds: Set<string>
  activeViewId: string
  showInfra: boolean
  showInferred: boolean

  selectNode: (id: string) => void
  clearSelection: () => void
  setHovered: (id: string | undefined) => void
  setAiHighlight: (h: AiHighlight | null) => void
  syncNewModules: (
    projectId: string,
    versionNo: number,
    currentNodes: GraphNode[],
    previousNodes: GraphNode[] | null
  ) => void
  acknowledgeModule: (projectId: string, nodeId: string) => void
  resetModuleAttention: (projectId: string) => void
  setActiveView: (id: string) => void
  toggleInfra: () => void
  toggleInferred: () => void
  /** Esc 逐层关闭:先清 AI 高亮,再清选中 */
  escape: () => void
}

export const useGraphView = create<GraphViewState>((set, get) => ({
  selectedNodeId: undefined,
  hoveredNodeId: undefined,
  aiHighlight: null,
  newModuleProjectId: null,
  newModuleIds: new Set(),
  activeViewId: 'overview',
  showInfra: true,
  showInferred: true,

  selectNode(id) {
    set(s => ({
      // 单击选中 / 单击已选中取消 / 单击他节点一次切换
      selectedNodeId: s.selectedNodeId === id ? undefined : id,
      aiHighlight: null
    }))
  },

  clearSelection() {
    set({ selectedNodeId: undefined })
  },

  setHovered(id) {
    set({ hoveredNodeId: id })
  },

  setAiHighlight(h) {
    set({ aiHighlight: h })
  },

  syncNewModules(projectId, versionNo, currentNodes, previousNodes) {
    const currentModuleIds = new Set(
      currentNodes.filter(node => node.kind === 'module').map(node => node.id)
    )
    const snapshot = readAttention(projectId)
    const acknowledged = new Set(snapshot.acknowledgedTokens)
    const pending = new Map(
      snapshot.pending
        .filter(item => currentModuleIds.has(item.nodeId) && !acknowledged.has(item.token))
        .map(item => [item.nodeId, item])
    )

    if (previousNodes !== null) {
      const previousModuleIds = new Set(
        previousNodes.filter(node => node.kind === 'module').map(node => node.id)
      )
      for (const nodeId of currentModuleIds) {
        if (previousModuleIds.has(nodeId)) continue
        const token = attentionToken(versionNo, nodeId)
        if (!acknowledged.has(token)) pending.set(nodeId, { nodeId, versionNo, token })
      }
    }

    const nextSnapshot = {
      pending: [...pending.values()],
      acknowledgedTokens: snapshot.acknowledgedTokens.slice(-500)
    }
    writeAttention(projectId, nextSnapshot)
    set({
      newModuleProjectId: projectId,
      newModuleIds: new Set(nextSnapshot.pending.map(item => item.nodeId))
    })
  },

  acknowledgeModule(projectId, nodeId) {
    const snapshot = readAttention(projectId)
    const acknowledged = new Set(snapshot.acknowledgedTokens)
    for (const item of snapshot.pending) {
      if (item.nodeId === nodeId) acknowledged.add(item.token)
    }
    const nextSnapshot = {
      pending: snapshot.pending.filter(item => item.nodeId !== nodeId),
      acknowledgedTokens: [...acknowledged].slice(-500)
    }
    writeAttention(projectId, nextSnapshot)
    if (get().newModuleProjectId === projectId) {
      const nextIds = new Set(get().newModuleIds)
      nextIds.delete(nodeId)
      set({ newModuleIds: nextIds })
    }
  },

  resetModuleAttention(projectId) {
    try {
      localStorage.removeItem(attentionKey(projectId))
    } catch {
    }
    if (get().newModuleProjectId === projectId) {
      set({ newModuleProjectId: projectId, newModuleIds: new Set() })
    }
  },

  setActiveView(id) {
    set({ activeViewId: id, selectedNodeId: undefined, aiHighlight: null })
  },

  toggleInfra() {
    set(s => ({ showInfra: !s.showInfra }))
  },

  toggleInferred() {
    set(s => ({ showInferred: !s.showInferred }))
  },

  escape() {
    if (get().aiHighlight) {
      set({ aiHighlight: null })
    } else {
      set({ selectedNodeId: undefined })
    }
  }
}))
