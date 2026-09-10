import { useState } from 'react'
import type { KnowledgeAssetEntry, KnowledgeAssetKind, KnowledgeAssetStatus, KnowledgeAssetSummary } from '../../api/types'
import type { KnowledgeCapability } from '../../stores/project'

interface KnowledgeAssetsPanelProps {
  assets?: KnowledgeAssetSummary[]
  capability?: KnowledgeCapability
  notice?: string | null
  busy?: boolean
  onGenerate?: () => void
  onDownload?: (asset: KnowledgeAssetSummary) => void
  onOpenEntry?: (asset: KnowledgeAssetSummary, entry: KnowledgeAssetEntry) => void
}

const EMPTY_ASSETS: KnowledgeAssetSummary[] = [
  {
    id: 'wiki-pending', projectId: '', kind: 'wiki', status: 'pending', version: null,
    versionId: null, sourceGraphVersionId: null, sourceGraphVersionNo: null, sourceCommitSha: null,
    repositoryCommits: {}, entries: [], downloadUrl: null, error: null, updatedAt: ''
  },
  {
    id: 'skills-pending', projectId: '', kind: 'skills', status: 'pending', version: null,
    versionId: null, sourceGraphVersionId: null, sourceGraphVersionNo: null, sourceCommitSha: null,
    repositoryCommits: {}, entries: [], downloadUrl: null, error: null, updatedAt: ''
  }
]

const ASSET_COPY: Record<KnowledgeAssetKind, { label: string; subtitle: string }> = {
  wiki: { label: 'Wiki', subtitle: '架构、流程与工程知识' },
  skills: { label: 'Skills', subtitle: 'Agent 可执行知识' }
}

const STATUS_COPY: Record<KnowledgeAssetStatus, string> = {
  ready: '已更新',
  generating: '生成中',
  updating: '更新中',
  pending: '待生成',
  failed: '更新失败',
  stale: '待同步'
}

function KnowledgeAssetIcon({ kind }: { kind: KnowledgeAssetKind }) {
  if (kind === 'wiki') {
    return (
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <path d="M8 15c9-3 17-1 24 5v31c-7-6-15-8-24-5z" />
        <path d="M56 15c-9-3-17-1-24 5v31c7-6 15-8 24-5z" />
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <rect x="7" y="10" width="50" height="44" rx="9" />
      <path d="m18 23 9 9-9 9M33 42h12" />
    </svg>
  )
}

export function KnowledgeAssetsPanel({
  assets = EMPTY_ASSETS,
  capability = 'unknown',
  notice = null,
  busy = false,
  onGenerate,
  onDownload,
  onOpenEntry
}: KnowledgeAssetsPanelProps) {
  const [expanded, setExpanded] = useState<KnowledgeAssetKind | null>(null)
  const visibleAssets = assets.length > 0 ? assets : EMPTY_ASSETS
  const unavailable = capability === 'unavailable'
  const statusOverride = capability === 'unknown' ? '检测中' : unavailable ? '未接入' : null

  return (
    <section
      className={`vo-knowledge-assets${unavailable ? ' is-unavailable' : ''}`}
      aria-labelledby="vo-knowledge-assets-title"
    >
      <div className="vo-knowledge-assets__head">
        <div className="vo-knowledge-assets__title" id="vo-knowledge-assets-title">
          工程知识资产
        </div>
        <button
          type="button"
          className={`vo-knowledge-assets__generate${busy ? ' is-busy' : ''}`}
          onClick={onGenerate}
          disabled={!onGenerate || busy}
          title={
            unavailable
              ? '当前环境未接入 Knowledge Generator 与 Skill Lab'
              : busy ? '知识资产正在生成或评测' : '生成或更新 Wiki 与 Skills'
          }
          aria-label="生成或更新工程知识资产"
        >
          <span className="vo-knowledge-assets__generate-icon" aria-hidden="true">↻</span>
        </button>
      </div>

      <div className="vo-knowledge-assets__list">
        {visibleAssets.map(asset => {
          const copy = ASSET_COPY[asset.kind]
          const isExpanded = expanded === asset.kind
          const canDownload = Boolean(asset.downloadUrl && asset.versionId)

          return (
            <div className={`vo-knowledge-asset${isExpanded ? ' is-expanded' : ''}`} key={asset.kind}>
              <div className="vo-knowledge-asset__row">
                <button
                  type="button"
                  className="vo-knowledge-asset__main"
                  aria-expanded={isExpanded}
                  onClick={() => setExpanded(current => current === asset.kind ? null : asset.kind)}
                >
                  <span className="vo-knowledge-asset__mark" aria-hidden="true">
                    <KnowledgeAssetIcon kind={asset.kind} />
                  </span>
                  <span className="vo-knowledge-asset__copy">
                    <strong>{copy.label}</strong>
                    <span>{copy.subtitle}</span>
                  </span>
                  <span className="vo-knowledge-asset__meta">
                    {asset.version && <code>{`v${asset.version}`}</code>}
                    <span className={statusOverride ? 'is-unavailable' : `is-${asset.status}`}>
                      {statusOverride ?? STATUS_COPY[asset.status]}
                    </span>
                  </span>
                  <span className="vo-knowledge-asset__chevron" aria-hidden="true">⌄</span>
                </button>

                <button
                  type="button"
                  className={`vo-knowledge-asset__download${canDownload ? '' : ' is-disabled'}`}
                  disabled={!canDownload}
                  title={canDownload ? `下载 ${copy.label}` : `${copy.label} 尚未生成`}
                  onClick={() => { if (canDownload) onDownload?.(asset) }}
                >
                  ↓
                </button>
              </div>

              {isExpanded && (
                <div className="vo-knowledge-asset__tree">
                  {asset.entries.length > 0 ? asset.entries.map(entry => (
                    <button
                      type="button"
                      key={entry.id}
                      title={entry.path}
                      onClick={() => onOpenEntry?.(asset, entry)}
                    >
                      <i aria-hidden="true" />
                      <span>{entry.title}</span>
                    </button>
                  )) : (
                    <div className="vo-knowledge-asset__empty">
                      {notice ?? `等待 Knowledge Generator 生成 ${copy.label}`}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
