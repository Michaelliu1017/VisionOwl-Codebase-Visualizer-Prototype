import { useEffect, useRef, useState } from 'react'
import {
  BaseEdge, EdgeLabelRenderer, getSmoothStepPath,
  type EdgeProps
} from '@xyflow/react'
import type { EdgeGeometry } from '../../graph/floating'
import type { EdgeType } from '../../api/types'

const TYPE_LABEL: Record<EdgeType, string> = {
  call: '调用', dependency: '依赖', read: '读', write: '写',
  publish: '发布', consume: '消费', implement: '实现', contains: '包含'
}

/**
 * 浮动边:边界锚点 + smoothstep 路径。
 * 可见路径 1.5px;命中路径由 React Flow interactionWidth(20px 透明)提供,
 * 满足契约的双路径要求。状态样式全部来自 className(选中态的投影)。
 */
export function FloatingEdge({
  id, source, target, data, markerEnd, interactionWidth,
  sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition
}: EdgeProps) {
  // 主图把 ELK 的稳定几何随 edge data 传入。这样选择节点时不依赖
  // React Flow 短暂重建的 internal-node lookup，连接线不会整层闪灭。
  const params = (data?.geometry as EdgeGeometry | undefined) ?? {
        sx: sourceX,
        sy: sourceY,
        tx: targetX,
        ty: targetY,
        sourcePos: sourcePosition,
        targetPos: targetPosition
      }
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX: params.sx, sourceY: params.sy, targetX: params.tx, targetY: params.ty,
    sourcePosition: params.sourcePos, targetPosition: params.targetPos,
    borderRadius: 8
  })

  const edgeType = data?.edgeType as EdgeType | undefined
  const step = data?.step as { order: number; label: string } | undefined
  const emphasized = Boolean(data?.emphasized)
  const pulse = Boolean(data?.pulse)

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={interactionWidth ?? 20} />
      {pulse && <FlowParticle path={path} />}
      {(step || edgeType) && (
        <EdgeLabelRenderer>
          <div
            className={`vo-edge-label${step ? ' is-step' : ''}${emphasized ? ' is-emphasized' : ''}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {step ? `${'①②③④⑤⑥⑦⑧⑨'[step.order - 1] ?? step.order} ${step.label}` : TYPE_LABEL[edgeType!]}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

/**
 * 方向光粒:单颗模糊发光粒子沿路径 source→target 恒速滑行(SMIL animateMotion),
 * 按路径长度换算时长保证长短边视觉速度一致;起点淡入、终点淡出。
 */
function FlowParticle({ path }: { path: string }) {
  const measureRef = useRef<SVGPathElement>(null)
  const [dur, setDur] = useState(0)

  useEffect(() => {
    const len = measureRef.current?.getTotalLength() ?? 0
    // 恒速 ≈230px/s,限幅 1.1s—3.4s,错峰启动由 SMIL 自身循环处理
    setDur(len > 0 ? Math.min(3.4, Math.max(1.1, len / 230)) : 0)
  }, [path])

  return (
    <>
      {/* 不可见量尺路径:取真实长度用于恒速换算 */}
      <path ref={measureRef} d={path} fill="none" stroke="none" aria-hidden="true" />
      {dur > 0 && (
        <g className="vo-edge__particle" aria-hidden="true">
          <circle className="vo-edge__particle-halo" r={7} />
          <circle className="vo-edge__particle-core" r={2.2} />
          <animateMotion dur={`${dur.toFixed(2)}s`} repeatCount="indefinite" path={path} />
          <animate
            attributeName="opacity"
            values="0;1;1;0"
            keyTimes="0;0.1;0.88;1"
            dur={`${dur.toFixed(2)}s`}
            repeatCount="indefinite"
          />
        </g>
      )}
    </>
  )
}
