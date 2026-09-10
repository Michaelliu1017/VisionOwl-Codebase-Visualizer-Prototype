import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { GraphNode } from '../../api/types'

const KIND_LABEL: Record<string, string> = {
  domain: '代码域', module: '模块', submodule: '内部模块', class: '类', function: '函数',
  interface: '接口', config: '配置', external: '外部'
}

function subtitleFor(node: GraphNode): string {
  const summary = node.summary?.trim()
  return summary || `${KIND_LABEL[node.kind] ?? node.kind} · ${node.path ?? '—'}`
}

/**
 * 模块节点(不透明石墨,交互契约:任何状态下背景完全不透明,防边线穿透)。
 * name/path 均为不可信输入,一律走 React 文本节点渲染(自动转义),禁止 innerHTML。
 */
export function ModuleNode({ data }: NodeProps) {
  const node = data.node as GraphNode
  return (
    <div className="vo-node__surface">
      <div className="vo-node__icon">{node.domain === 'apps' ? '▤' : node.domain === 'packages' ? '▢' : '◆'}</div>
      <div className="vo-node__copy">
        <strong>{node.name}</strong>
        <span title={subtitleFor(node)}>{subtitleFor(node)}</span>
      </div>
      {/* 隐藏 Handle:边由 FloatingEdge 计算边界锚点,不用 handle 定位 */}
      <Handle type="source" position={Position.Bottom} className="vo-handle" />
      <Handle type="target" position={Position.Top} className="vo-handle" />
    </div>
  )
}

/** 基础设施节点:圆柱造型,与代码模块在形状上区分 */
export function InfraNode({ data }: NodeProps) {
  const node = data.node as GraphNode
  const sub = node.kind === 'infra.db' ? '数据库' : node.kind === 'infra.redis' ? '缓存' : '消息队列'
  return (
    <div className="vo-infra">
      <svg className="vo-infra__shape" viewBox="0 0 104 52" aria-hidden="true">
        <path d="M8 12 v28 a44 8 0 0 0 88 0 v-28" className="vo-infra__body" />
        <ellipse cx="52" cy="12" rx="44" ry="8" className="vo-infra__lid" />
      </svg>
      <div className="vo-infra__copy">
        <strong>{node.name}</strong>
        <span>{sub}</span>
      </div>
      <Handle type="source" position={Position.Bottom} className="vo-handle" />
      <Handle type="target" position={Position.Top} className="vo-handle" />
    </div>
  )
}
