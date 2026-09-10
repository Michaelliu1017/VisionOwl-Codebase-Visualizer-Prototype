import { Position, type InternalNode } from '@xyflow/react'

export interface EdgeGeometry {
  sx: number
  sy: number
  tx: number
  ty: number
  sourcePos: Position
  targetPos: Position
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 边界锚点计算(交互契约:连线接节点边界,禁止中心连中心)。
 * 取两节点中心连线的主导方向,选择对应边的中点作为锚点,
 * 配合 smoothstep 路径得到整洁的正交观感。
 */

function centerOf(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

function anchorOn(rect: Rect, side: Position): { x: number; y: number } {
  const { x, y, width: w, height: h } = rect
  switch (side) {
    case Position.Top: return { x: x + w / 2, y }
    case Position.Bottom: return { x: x + w / 2, y: y + h }
    case Position.Left: return { x, y: y + h / 2 }
    case Position.Right: return { x: x + w, y: y + h / 2 }
  }
}

export function getEdgeParamsFromRects(source: Rect, target: Rect): EdgeGeometry {
  const sc = centerOf(source)
  const tc = centerOf(target)
  const dx = tc.x - sc.x
  const dy = tc.y - sc.y

  let sourcePos: Position
  let targetPos: Position
  if (Math.abs(dy) >= Math.abs(dx)) {
    sourcePos = dy > 0 ? Position.Bottom : Position.Top
    targetPos = dy > 0 ? Position.Top : Position.Bottom
  } else {
    sourcePos = dx > 0 ? Position.Right : Position.Left
    targetPos = dx > 0 ? Position.Left : Position.Right
  }

  const s = anchorOn(source, sourcePos)
  const t = anchorOn(target, targetPos)
  return { sx: s.x, sy: s.y, tx: t.x, ty: t.y, sourcePos, targetPos }
}

export function getEdgeParams(source: InternalNode, target: InternalNode): EdgeGeometry {
  const toRect = (node: InternalNode): Rect => ({
    ...node.internals.positionAbsolute,
    // React Flow 在布局切换时会短暂清空 measured;显式 width/initialWidth
    // 是同一节点的稳定尺寸，避免此时边退化成 0 长度。
    width: node.measured?.width ?? node.width ?? node.initialWidth ?? 0,
    height: node.measured?.height ?? node.height ?? node.initialHeight ?? 0
  })
  return getEdgeParamsFromRects(toRect(source), toRect(target))
}
