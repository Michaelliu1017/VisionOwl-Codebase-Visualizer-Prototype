import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background, BackgroundVariant, MarkerType, MiniMap, ReactFlow,
  ReactFlowProvider, ViewportPortal, useReactFlow,
  type Edge, type Node
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { api } from '../../api/client'
import type { GraphEdge, GraphNode } from '../../api/types'
import { getEdgeParamsFromRects } from '../../graph/floating'
import { layoutGraph, sizeOf, type LayoutedPosition } from '../../graph/layout'
import { resolveGraphView } from '../../graph/viewGuard'
import { useGraphView } from '../../stores/graph'
import { useProject } from '../../stores/project'
import { DocCard, DOC_CARD_GAP, DOC_CARD_H, DOC_CARD_W } from './DocCard'
import { FloatingEdge } from './FloatingEdge'
import { InfraNode, ModuleNode } from './nodes'

const nodeTypes = { module: ModuleNode, infra: InfraNode }
const edgeTypes = { floating: FloatingEdge }

const DOMAIN_LABEL: Record<string, string> = {
  client: '客户端',
  'local-runtime': '本地分析环境',
  'cloud-runtime': '后端',
  shared: '共享契约与基础能力',
  external: '外部系统',
  apps: '应用层 · apps',
  modules: '业务模块 · modules',
  packages: '共享包 · packages',
  infra: '基础设施 · infra'
}

function displayGroupOf(node: GraphNode): string {
  return node.architecture?.displayGroup ?? node.domain ?? 'other'
}

const EDGE_COLOR = {
  default: '#849187',
  inferred: '#64936d',
  accent: '#58ff3d',
  amber: '#ffc85a'
}

function FlowInner() {
  const artifact = useProject(s => s.artifact)
  const project = useProject(s => s.project)
  const graphVersion = useProject(s => s.graphVersion)
  const adjacency = useProject(s => s.adjacency)
  const documents = useProject(s => s.documents)
  const openDocument = useProject(s => s.openDocument)
  const selectedNodeId = useGraphView(s => s.selectedNodeId)
  const aiHighlight = useGraphView(s => s.aiHighlight)
  const newModuleProjectId = useGraphView(s => s.newModuleProjectId)
  const newModuleIds = useGraphView(s => s.newModuleIds)
  const activeViewId = useGraphView(s => s.activeViewId)
  const setActiveView = useGraphView(s => s.setActiveView)
  const showInfra = useGraphView(s => s.showInfra)
  const showInferred = useGraphView(s => s.showInferred)
  const selectNode = useGraphView(s => s.selectNode)
  const syncNewModules = useGraphView(s => s.syncNewModules)
  const acknowledgeModule = useGraphView(s => s.acknowledgeModule)
  const escape = useGraphView(s => s.escape)

  const { fitView, flowToScreenPosition, getViewport, setViewport } = useReactFlow()
  const wrapRef = useRef<HTMLDivElement>(null)
  const comparedGraphRef = useRef<string | null>(null)
  const [positions, setPositions] = useState<Map<string, LayoutedPosition>>(new Map())
  const [obscured, setObscured] = useState<Set<string>>(new Set())

  const resolvedView = useMemo(
    () => resolveGraphView(artifact, activeViewId),
    [artifact, activeViewId]
  )

  useEffect(() => {
    if (resolvedView.requested || !resolvedView.preferred) return
    setActiveView(resolvedView.preferred.id)
  }, [resolvedView, setActiveView])

  useEffect(() => {
    if (!project || !graphVersion || !artifact) return
    const comparisonKey = `${project.id}:${graphVersion.versionNo}`
    if (comparedGraphRef.current === comparisonKey) return
    let cancelled = false

    void (async () => {
      let previousNodes: GraphNode[] | null = null
      if (graphVersion.versionNo === 1) {
        previousNodes = []
      } else {
        try {
          const previousVersion = await api.getGraphVersion(project.id, graphVersion.versionNo - 1)
          const previousArtifact = await api.getGraphArtifact(previousVersion.artifactUrl)
          previousNodes = previousArtifact.nodes
        } catch (error) {
          console.warn('[visionowl] 无法读取上一图谱版本，新模块提示沿用本地状态:', error)
        }
      }
      if (!cancelled) {
        syncNewModules(project.id, graphVersion.versionNo, artifact.nodes, previousNodes)
        comparedGraphRef.current = comparisonKey
      }
    })()

    return () => { cancelled = true }
  }, [project, graphVersion, artifact, syncNewModules])

  // ---- 可见集合:只由当前架构视图决定。内部组件固定留在右侧详情面板。 ----
  const { visibleNodes, visibleEdges, steps } = useMemo(() => {
    if (!artifact) {
      return { visibleNodes: [] as GraphNode[], visibleEdges: [] as GraphEdge[], steps: new Map<string, { order: number; label: string }>() }
    }
    const view = resolvedView.render
    if (!view) {
      return { visibleNodes: [] as GraphNode[], visibleEdges: [] as GraphEdge[], steps: new Map<string, { order: number; label: string }>() }
    }
    const nodeSet = new Set(view.nodeIds)
    const edgeSet = new Set(view.edgeIds)
    let nodes = artifact.nodes.filter(n => nodeSet.has(n.id))
    if (!showInfra) nodes = nodes.filter(n => !n.kind.startsWith('infra.'))
    const nodeIds = new Set(nodes.map(n => n.id))

    let edges = artifact.edges.filter(
      e => edgeSet.has(e.id) && nodeIds.has(e.source) && nodeIds.has(e.target)
    )
    if (!showInferred) edges = edges.filter(e => !e.inferred)

    const steps = new Map<string, { order: number; label: string }>()
    for (const s of view.steps ?? []) steps.set(s.edgeId, { order: s.order, label: s.label })
    return { visibleNodes: nodes, visibleEdges: edges, steps }
  }, [artifact, resolvedView.render, showInfra, showInferred])

  // ---- elk 布局:可见集合变化时重算 ----
  useEffect(() => {
    let cancelled = false
    if (visibleNodes.length === 0) return
    layoutGraph(visibleNodes, visibleEdges).then(pos => {
      if (cancelled) return
      setPositions(pos)
      // rAF 在不可见标签页不会执行,再给一个宏任务兼底,避免视口永远不适配
      requestAnimationFrame(() => fitView({ padding: 0.14, duration: 260 }))
      setTimeout(() => { if (!cancelled) void fitView({ padding: 0.14, duration: 0 }) }, 400)
    })
    return () => { cancelled = true }
  }, [visibleNodes, visibleEdges, fitView])

  // ---- Esc 逐层关闭 ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') escape()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [escape])

  // ---- 遮挡回退:Agent 玻璃窗盖住的无关节点压暗 ----
  const recomputeObscured = useCallback(() => {
    const consoleEl = document.querySelector('.vo-console.is-open')
    if (!consoleEl) { setObscured(new Set()); return }
    const c = consoleEl.getBoundingClientRect()
    const next = new Set<string>()
    for (const n of visibleNodes) {
      const p = positions.get(n.id)
      if (!p) continue
      const { width, height } = sizeOf(n)
      const tl = flowToScreenPosition({ x: p.x, y: p.y })
      const br = flowToScreenPosition({ x: p.x + width, y: p.y + height })
      const overlap = tl.x < c.right && br.x > c.left && tl.y < c.bottom && br.y > c.top
      if (overlap) next.add(n.id)
    }
    setObscured(next)
  }, [visibleNodes, positions, flowToScreenPosition])

  useEffect(() => {
    recomputeObscured()
    const t = setInterval(recomputeObscured, 600) // 控制台拖高/布局动画期间的低频兜底
    return () => clearInterval(t)
  }, [recomputeObscured])

  // ---- 状态投影 → React Flow 元素 ----
  const related = selectedNodeId ? adjacency.get(selectedNodeId) : undefined
  const aiNodes = useMemo(() => new Set(aiHighlight?.nodeIds ?? []), [aiHighlight])
  const aiEdges = useMemo(() => new Set(aiHighlight?.edgeIds ?? []), [aiHighlight])

  const rfNodes: Node[] = useMemo(() => visibleNodes.map(n => {
    const { width, height } = sizeOf(n)
    const isSelected = n.id === selectedNodeId
    const isRelated = Boolean(related?.nodeIds.has(n.id))
    const isAi = aiNodes.has(n.id)
    const isNewModule = newModuleProjectId === project?.id && newModuleIds.has(n.id)
    // 状态优先级:selected > related > ai > obscured > dimmed > default
    const isDimmed = Boolean(selectedNodeId) && !isSelected && !isRelated && !isNewModule
    const isObscured = obscured.has(n.id) && !isSelected && !isRelated && !isNewModule
    const cls = [
      'vo-node',
      n.kind === 'submodule' && 'is-submodule',
      isNewModule && 'is-new-module',
      isSelected && 'is-selected',
      !isSelected && isRelated && 'is-related',
      !isSelected && !isRelated && isAi && 'is-ai',
      isDimmed && !isAi && 'is-dimmed',
      isObscured && 'is-obscured'
    ].filter(Boolean).join(' ')

    return {
      id: n.id,
      type: n.kind.startsWith('infra.') ? 'infra' : 'module',
      position: positions.get(n.id) ?? { x: 0, y: 0 },
      data: { node: n },
      className: cls,
      width,
      height,
      initialWidth: width,
      initialHeight: height,
      // 选中态会替换受控 node 对象。显式保留 measured 尺寸，避免 React Flow
      // 把全部节点重新判为“未初始化”并暂停整层边渲染。
      measured: { width, height },
      zIndex: isSelected ? 20 : isRelated ? 14 : 10,
      draggable: false,
      connectable: false
    }
  }), [visibleNodes, positions, selectedNodeId, related, aiNodes, obscured, newModuleProjectId, newModuleIds, project?.id])

  const rfEdges: Edge[] = useMemo(() => visibleEdges.map(e => {
    const emphasized = Boolean(related?.edgeIds.has(e.id))
    const isAi = aiEdges.has(e.id)
    const dimmed = Boolean(selectedNodeId) && !emphasized
    const step = steps.get(e.id)
    const color = emphasized || isAi
      ? EDGE_COLOR.accent
      : e.inferred ? EDGE_COLOR.inferred : EDGE_COLOR.default
    const sourceNode = visibleNodes.find(node => node.id === e.source)
    const targetNode = visibleNodes.find(node => node.id === e.target)
    const sourcePosition = positions.get(e.source)
    const targetPosition = positions.get(e.target)
    const geometry = sourceNode && targetNode && sourcePosition && targetPosition
      ? getEdgeParamsFromRects(
          { ...sourcePosition, ...sizeOf(sourceNode) },
          { ...targetPosition, ...sizeOf(targetNode) }
        )
      : undefined

    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'floating',
      // 脉冲仅用于被强调的关系(选中邻接/AI 高亮/流程步骤),遵守 skill“禁止全图持续动画”
      data: {
        edgeType: e.type,
        emphasized,
        step,
        pulse: emphasized || isAi || Boolean(step),
        geometry
      },
      className: [
        'vo-edge',
        emphasized && 'is-related',
        isAi && 'is-ai',
        e.inferred && 'is-inferred',
        dimmed && !isAi && 'is-dimmed'
      ].filter(Boolean).join(' '),
      markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color },
      zIndex: 1
    }
  }), [visibleEdges, visibleNodes, positions, selectedNodeId, related, aiEdges, steps])

  // ---- 关联文档玻璃卡:选中节点旁展开,虚线连接(次级上下文,skill 玻璃材质) ----
  const docPlacements = useMemo(() => {
    if (!selectedNodeId || !artifact) return []
    const selNode = visibleNodes.find(n => n.id === selectedNodeId)
    const sp = positions.get(selectedNodeId)
    if (!selNode || !sp) return []

    const docs = documents.filter(d => d.nodeId === selectedNodeId)
    if (docs.length === 0) return []

    const { width: sw, height: sh } = sizeOf(selNode)
    const totalH = docs.length * DOC_CARD_H + (docs.length - 1) * DOC_CARD_GAP
    const y0 = sp.y + sh / 2 - totalH / 2

    // 碰撞避让:左/右两侧 × 逐步外推,选第一个不与任何节点相交的列位置
    const obstacles = visibleNodes
      .filter(n => n.id !== selectedNodeId)
      .map(n => {
        const p = positions.get(n.id)
        if (!p) return null
        const s = sizeOf(n)
        return { x: p.x, y: p.y, w: s.width, h: s.height }
      })
      .filter((r): r is { x: number; y: number; w: number; h: number } => r !== null)

    const M = 24 // 卡列与障碍物的安全边距
    const collides = (x: number) => obstacles.some(o =>
      x - M < o.x + o.w && x + DOC_CARD_W + M > o.x &&
      y0 - M < o.y + o.h && y0 + totalH + M > o.y
    )

    const gap = 110
    const candidates: number[] = []
    const graphMinX = Math.min(...obstacles.map(o => o.x), sp.x)
    const graphMaxX = Math.max(...obstacles.map(o => o.x + o.w), sp.x + sw)
    const selectedCenterX = sp.x + sw / 2
    const preferLeft = selectedCenterX > (graphMinX + graphMaxX) / 2
    for (let t = 0; t < 4; t++) {
      const left = sp.x - gap - DOC_CARD_W - t * 180
      const right = sp.x + sw + gap + t * 180
      // 靠图左侧的节点优先向右展开，反之向左，避免卡片一出现就落到视口外。
      candidates.push(...(preferLeft ? [left, right] : [right, left]))
    }
    const x = candidates.find(c => !collides(c)) ?? candidates[0]

    const cardsOnLeft = x < sp.x
    return docs.map((doc, index) => {
      const y = y0 + index * (DOC_CARD_H + DOC_CARD_GAP)
      const sourceX = cardsOnLeft ? x + DOC_CARD_W : x
      const sourceY = y + DOC_CARD_H / 2
      const targetX = cardsOnLeft ? sp.x : sp.x + sw
      const targetY = sp.y + sh / 2
      const midX = sourceX + (targetX - sourceX) / 2
      return {
        doc,
        index,
        x,
        y,
        path: `M ${sourceX} ${sourceY} H ${midX} V ${targetY} H ${targetX}`
      }
    })
  }, [selectedNodeId, artifact, visibleNodes, positions, documents])

  // 只在文档列确实落到画布外时做最小平移，不强行把选中模块居中。
  useEffect(() => {
    if (docPlacements.length === 0) return
    const frame = requestAnimationFrame(() => {
      const canvas = wrapRef.current?.getBoundingClientRect()
      if (!canvas) return
      const first = docPlacements[0]
      const last = docPlacements[docPlacements.length - 1]
      const topLeft = flowToScreenPosition({ x: first.x, y: first.y })
      const bottomRight = flowToScreenPosition({
        x: last.x + DOC_CARD_W,
        y: last.y + DOC_CARD_H
      })
      const inset = 16
      let shiftX = 0
      let shiftY = 0
      if (topLeft.x < canvas.left + inset) shiftX = canvas.left + inset - topLeft.x
      else if (bottomRight.x > canvas.right - inset) shiftX = canvas.right - inset - bottomRight.x
      if (topLeft.y < canvas.top + inset) shiftY = canvas.top + inset - topLeft.y
      else if (bottomRight.y > canvas.bottom - inset) shiftY = canvas.bottom - inset - bottomRight.y
      if (shiftX === 0 && shiftY === 0) return
      const viewport = getViewport()
      void setViewport(
        { ...viewport, x: viewport.x + shiftX, y: viewport.y + shiftY },
        { duration: 220 }
      )
    })
    return () => cancelAnimationFrame(frame)
  }, [docPlacements, flowToScreenPosition, getViewport, setViewport])

  // ---- 域分组框(依据布局包围盒) ----
  const frames = useMemo(() => {
    const byDomain = new Map<string, { minX: number; minY: number; maxX: number; maxY: number; label: string }>()
    for (const n of visibleNodes) {
      const p = positions.get(n.id)
      if (!p) continue
      const { width, height } = sizeOf(n)
      const domain = displayGroupOf(n)
      const b = byDomain.get(domain) ?? {
        minX: Infinity,
        minY: Infinity,
        maxX: -Infinity,
        maxY: -Infinity,
        label: domain === 'cloud-runtime'
          ? DOMAIN_LABEL[domain]
          : n.architecture?.groupLabel ?? DOMAIN_LABEL[domain] ?? domain
      }
      b.minX = Math.min(b.minX, p.x); b.minY = Math.min(b.minY, p.y)
      b.maxX = Math.max(b.maxX, p.x + width); b.maxY = Math.max(b.maxY, p.y + height)
      byDomain.set(domain, b)
    }
    return [...byDomain.entries()].filter(([, b]) => Number.isFinite(b.minX))
  }, [visibleNodes, positions])

  return (
    <div className="vo-canvas" ref={wrapRef}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={(_, node) => {
          if (project) acknowledgeModule(project.id, node.id)
          selectNode(node.id)
        }}
        onPaneClick={() => escape()}
        onMoveEnd={recomputeObscured}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        minZoom={0.3}
        maxZoom={1.8}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={26} size={1} color="#141714" />
        <ViewportPortal>
          {docPlacements.length > 0 && (
            <svg className="vo-doclinks" aria-hidden="true">
              {docPlacements.map(item => (
                <path key={item.doc.id} className="vo-doclink__path" d={item.path} />
              ))}
            </svg>
          )}
          {frames.map(([domain, b]) => (
            <div
              key={domain}
              className="vo-frame"
              style={{
                transform: `translate(${b.minX - 26}px, ${b.minY - 40}px)`,
                width: b.maxX - b.minX + 52,
                height: b.maxY - b.minY + 66
              }}
            >
              <span>{b.label}</span>
            </div>
          ))}
          {docPlacements.map(item => (
            <button
              key={item.doc.id}
              type="button"
              className="vo-docnode vo-docnode--portal"
              style={{
                transform: `translate(${item.x}px, ${item.y}px)`,
                width: DOC_CARD_W,
                height: DOC_CARD_H
              }}
              onClick={event => {
                event.stopPropagation()
                void openDocument(item.doc)
              }}
            >
              <DocCard doc={item.doc} index={item.index} />
            </button>
          ))}
        </ViewportPortal>
        <MiniMap
          className="vo-minimap"
          pannable
          nodeColor={n => (n.className?.includes('is-selected') ? '#58ff3d' : '#202420')}
          maskColor="rgb(5 6 5 / 72%)"
        />
      </ReactFlow>
      {resolvedView.guarded && (
        <div className="vo-canvas-guard" role="status">
          大型视图已折叠 · {resolvedView.sourceNodeCount.toLocaleString()} 个节点
        </div>
      )}
      <div className="vo-canvas-hint">点击节点高亮交互链路 · 点击空白取消 · Esc 逐层清除</div>
    </div>
  )
}

export function GraphCanvas() {
  return (
    <ReactFlowProvider>
      <FlowInner />
    </ReactFlowProvider>
  )
}
