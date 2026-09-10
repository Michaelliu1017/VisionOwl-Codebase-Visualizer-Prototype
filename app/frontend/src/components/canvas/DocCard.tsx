import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { DocumentLink } from '../../api/types'

export const DOC_CARD_W = 248
export const DOC_CARD_H = 84
export const DOC_CARD_GAP = 18

interface DocCardProps {
  doc: DocumentLink
  index: number
}

export function DocCard({ doc, index }: DocCardProps) {
  return (
    <div className="vo-doccard" style={{ animationDelay: `${index * 45}ms` }}>
      <div className="vo-doccard__icon">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            d="M12 5.5C10.4 4.3 8.3 3.8 6 3.8c-1 0-2 .1-2.8.4v13.6c.9-.3 1.8-.4 2.8-.4 2.3 0 4.4.5 6 1.7 1.6-1.2 3.7-1.7 6-1.7 1 0 2 .1 2.8.4V4.2c-.9-.3-1.8-.4-2.8-.4-2.3 0-4.4.5-6 1.7Zm0 0v13.6"
            fill="none" stroke="currentColor" strokeWidth="1.6"
            strokeLinecap="round" strokeLinejoin="round"
          />
        </svg>
      </div>
      <div className="vo-doccard__copy">
        <span className="vo-doccard__tag">
          关联文档{doc.status === 'maybe_stale' && <em> · 可能过期</em>}
          {doc.status === 'sync_failed' && <em> · 同步失败</em>}
        </span>
        <strong>{doc.title}</strong>
        <span className="vo-doccard__sub">打开文档查看完整内容</span>
      </div>
    </div>
  )
}

/**
 * 关联文档玻璃卡:选中节点旁的次级上下文对象。
 * 按 skill 材质契约使用磨砂玻璃(区别于不透明的主节点),点击打开文档。
 */
export function DocCardNode({ data }: NodeProps) {
  const doc = data.doc as DocumentLink
  const index = (data.index as number) ?? 0
  return (
    <div>
      <DocCard doc={doc} index={index} />
      <Handle type="source" position={Position.Right} className="vo-handle" />
      <Handle type="target" position={Position.Left} className="vo-handle" />
    </div>
  )
}
