import { useMemo, useState } from 'react'
import { useGraphView } from '../../stores/graph'
import { useProject } from '../../stores/project'
import { KnowledgeAssetsPanel } from './KnowledgeAssetsPanel'
import { ProjectSidebarHeader } from './TopBar'

const GROUP_ORDER = ['client', 'local-runtime', 'cloud-runtime', 'shared', 'external', 'apps', 'modules', 'packages', 'infra']
const GROUP_LABEL: Record<string, string> = {
  client: '客户端',
  'local-runtime': '本地分析环境',
  'cloud-runtime': '后端',
  shared: '共享契约与基础能力',
  external: '外部系统',
  apps: '应用', modules: '业务模块', packages: '共享包', infra: '基础设施', other: '未分类'
}
const MAX_SIDEBAR_ARCHITECTURE_NODES = 24

export function SideTree() {
  const artifact = useProject(s => s.artifact)
  const graphVersion = useProject(s => s.graphVersion)
  const selectedNodeId = useGraphView(s => s.selectedNodeId)
  const selectNode = useGraphView(s => s.selectNode)
  const showInfra = useGraphView(s => s.showInfra)
  const showInferred = useGraphView(s => s.showInferred)
  const toggleInfra = useGraphView(s => s.toggleInfra)
  const toggleInferred = useGraphView(s => s.toggleInferred)
  const [filter, setFilter] = useState('')
  const knowledgeAssets = useProject(s => s.knowledgeAssets)
  const knowledgeRun = useProject(s => s.knowledgeRun)
  const knowledgeCapability = useProject(s => s.knowledgeCapability)
  const knowledgeNotice = useProject(s => s.knowledgeNotice)
  const generateKnowledgeAssets = useProject(s => s.generateKnowledgeAssets)
  const downloadKnowledgeAsset = useProject(s => s.downloadKnowledgeAsset)
  const openKnowledgeAssetEntry = useProject(s => s.openKnowledgeAssetEntry)

  const architectureNodeIds = useMemo(() => {
    if (!artifact) return new Set<string>()
    const overview = artifact.views.find(view => view.id === 'project:overview')
      ?? artifact.views.find(view => view.id === 'overview')
      ?? artifact.views.find(view => view.id.endsWith(':overview'))
    if (overview) return new Set(overview.nodeIds.slice(0, MAX_SIDEBAR_ARCHITECTURE_NODES))
    return new Set(artifact.nodes
      .filter(node => node.architecture?.visibleByDefault ?? (!node.parentId && node.kind === 'module'))
      .slice(0, MAX_SIDEBAR_ARCHITECTURE_NODES)
      .map(node => node.id))
  }, [artifact])

  const architectureNodes = useMemo(() => artifact?.nodes.filter(node =>
    !node.parentId && architectureNodeIds.has(node.id)
  ) ?? [], [artifact, architectureNodeIds])

  const groups = useMemo(() => {
    if (!artifact) return []
    const kw = filter.trim().toLowerCase()
    const grouped = new Map<string, typeof architectureNodes>()
    for (const node of architectureNodes) {
      const domain = node.architecture?.displayGroup ??
        (typeof node.domain === 'string' && node.domain.trim() ? node.domain : 'other')
      const name = typeof node.name === 'string' && node.name.trim() ? node.name : node.id
      if (kw && !name.toLowerCase().includes(kw)) continue
      grouped.set(domain, [...(grouped.get(domain) ?? []), node])
    }
    const domains = [...grouped.keys()]
      .sort((a, b) => {
        const ai = GROUP_ORDER.indexOf(a)
        const bi = GROUP_ORDER.indexOf(b)
        if (ai === -1 && bi === -1) return a.localeCompare(b)
        if (ai === -1) return 1
        if (bi === -1) return -1
        return ai - bi
      })
    return domains.map(domain => ({
      domain,
      nodes: grouped.get(domain) ?? []
    })).filter(g => g.nodes.length > 0)
  }, [artifact, architectureNodes, filter])

  return (
    <aside className="vo-sidetree">
      <ProjectSidebarHeader />
      <KnowledgeAssetsPanel
        assets={knowledgeAssets}
        capability={knowledgeCapability}
        notice={knowledgeNotice}
        busy={
          knowledgeCapability === 'available' && (
            Boolean(knowledgeRun && !['succeeded', 'failed', 'canceled'].includes(knowledgeRun.status)) ||
            knowledgeAssets.some(asset => asset.status === 'generating' || asset.status === 'updating')
          )
        }
        onGenerate={knowledgeCapability === 'available' && graphVersion
          ? () => { void generateKnowledgeAssets(true) }
          : undefined}
        onDownload={asset => { void downloadKnowledgeAsset(asset) }}
        onOpenEntry={(asset, entry) => { void openKnowledgeAssetEntry(asset, entry) }}
      />
      <div className="vo-panel-title">
        <span>项目结构</span>
        <span className="vo-panel-title__meta">{architectureNodes.length}</span>
      </div>

      <div className="vo-tree-filter">
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="过滤模块…"
          spellCheck={false}
        />
      </div>

      <div className="vo-tree">
        {groups.map(g => (
          <div key={g.domain}>
            <div className="vo-tree__group">{GROUP_LABEL[g.domain] ?? g.domain}</div>
            {g.nodes.map(n => (
              <button
                key={n.id}
                type="button"
                className={`vo-tree__item${n.id === selectedNodeId ? ' is-active' : ''}`}
                onClick={() => selectNode(n.id)}
              >
                <i className="vo-tree__kind" />
                <span>{n.name || n.id}</span>
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="vo-side-section">
        <div className="vo-side-section__title">图层筛选</div>
        <label className="vo-check">
          <input type="checkbox" checked={showInfra} onChange={toggleInfra} />
          <span>显示基础设施节点</span>
        </label>
        <label className="vo-check">
          <input type="checkbox" checked={showInferred} onChange={toggleInferred} />
          <span>显示推断关系(暗绿色)</span>
        </label>
      </div>

      <div className="vo-side-section">
        <div className="vo-side-section__title">最近分析</div>
        <div className="vo-side-mono">
          ✓ v{graphVersion?.versionNo ?? '—'} · {graphVersion?.commitSha ?? '—'} · 刚刚
        </div>
      </div>
    </aside>
  )
}
