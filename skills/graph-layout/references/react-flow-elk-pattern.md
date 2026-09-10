# React Flow + ELK 实现模式

配套 `../SKILL.md` 的实现细节。代码为 TypeScript，基于 `@xyflow/react` v12 与 `elkjs`。片段是可直接采用的骨架，不是伪代码。

## 0. 依赖

```bash
npm i @xyflow/react elkjs zustand
```

```ts
import ELK from "elkjs/lib/elk.bundled.js";
// 大图放 worker，布局不阻塞主线程：
// const elk = new ELK({ workerFactory: () => new Worker(new URL("elkjs/lib/elk-worker.min.js", import.meta.url)) });
const elk = new ELK();
```

## 1. 数据模型

```ts
// ---- 事实层（只读输入）----
export interface FactNode {
  id: string;
  label: string;
  kind: "module" | "infra";
  infraKind?: string;          // postgres | redis | kafka | ...（kind=infra 时必填）
  repo: string;                // Git 仓库标识，最外层容器
  path: string;                // 仓库内路径，供路径分组
  group?: string;              // 显式架构分组（若有），须另记出处
}

export interface FactEdge {
  id: string;                  // relation ID，全局唯一，聚合与还原的锚点
  source: string;
  target: string;
  type: string;                // imports | calls | reads | writes | pushes | pops | dispatches | reports
  weight?: number;             // 默认 1
}

export interface FactGraph { nodes: FactNode[]; edges: FactEdge[] }

// ---- 容器树（grouping 的产物）----
export interface ContainerNode {
  id: string;                  // 如 "repo:team-046/domain:booking"
  label: string;
  parentId?: string;           // 仓库容器无 parent
  source: "architecture" | "path" | "density";  // 分组依据，density 需 UI 标注"自动分组"
}

// ---- 呈现层（派生，不手改）----
export interface PresNode {
  id: string;
  type: "container" | "module" | "infra";
  parentId?: string;
  data: {
    label: string;
    collapsed?: boolean;
    interiorRelationIds?: string[];   // 折叠容器：两端都在内部的事实边
    infraKind?: string;
  };
  position: { x: number; y: number };
  width?: number; height?: number;
}

export interface PresEdge {
  id: string;                  // 精确边沿用事实边 id；trunk 用 "trunk:src=>tgt"
  source: string; target: string;
  type: "precise" | "trunk";
  data: {
    relationIds: string[];     // 精确边也填 [自身 id]，校验器统一处理
    byType: Record<string, number>;
    weight: number;            // Σ 成员 weight，决定粗细与网格打分
  };
}
```

## 2. 派生呈现图（唯一的聚合入口）

核心是 `proxy` 函数：一个事实节点的可见代理 = 从仓库容器往下走、遇到的**第一个折叠容器**；全程无折叠则是节点自身。

```ts
export function derivePresentation(
  fact: FactGraph,
  containers: ContainerNode[],
  collapsed: ReadonlySet<string>,
): { nodes: PresNode[]; edges: PresEdge[] } {
  const chainOf = buildAncestorChains(fact.nodes, containers); // nodeId -> [repo, domain, ...] 自顶向下
  const proxy = (nodeId: string): string =>
    chainOf.get(nodeId)!.find((c) => collapsed.has(c)) ?? nodeId;

  const interior = new Map<string, string[]>();      // 折叠容器 id -> 内部边
  const buckets = new Map<string, FactEdge[]>();     // "vs=>vt" -> 跨容器边
  const precise: FactEdge[] = [];

  for (const e of [...fact.edges].sort((a, b) => a.id.localeCompare(b.id))) { // 排序保证确定性
    const vs = proxy(e.source), vt = proxy(e.target);
    if (vs === vt && collapsed.has(vs)) { push(interior, vs, e.id); continue; }   // 状态 3
    if (vs === e.source && vt === e.target) { precise.push(e); continue; }        // 状态 1
    push(buckets, `${vs}=>${vt}`, e);                                             // 状态 2（方向分开）
  }

  const edges: PresEdge[] = [
    ...precise.map((e) => ({
      id: e.id, source: e.source, target: e.target, type: "precise" as const,
      data: { relationIds: [e.id], byType: { [e.type]: 1 }, weight: e.weight ?? 1 },
    })),
    ...[...buckets.entries()].map(([key, members]) => {
      const [vs, vt] = key.split("=>");
      return {
        id: `trunk:${key}`, source: vs, target: vt, type: "trunk" as const,
        data: {
          relationIds: members.map((m) => m.id),
          byType: countBy(members, (m) => m.type),
          weight: members.reduce((s, m) => s + (m.weight ?? 1), 0),
        },
      };
    }),
  ];
  const nodes = deriveVisibleNodes(fact, containers, collapsed, interior); // 折叠容器带 interiorRelationIds
  return { nodes: sortParentsFirst(nodes), edges };  // React Flow 要求父节点排在子节点前
}
```

规则要点：

- 一端精确、一端容器的边也走 trunk 通道（bucket 大小可能为 1）；`relationIds` 统一存在，数量徽标在 `length === 1` 时不渲染。
- 折叠/展开只改 `collapsed` 集合，重新调用 `derivePresentation`——没有第二条改图路径。
- focus / path 模式 = 计算一个折叠集预设 + 一份 overlay 样式集，不进入本函数。

## 3. 无损校验器（交付门禁）

```ts
export function assertLossless(fact: FactGraph, pres: { nodes: PresNode[]; edges: PresEdge[] }): string[] {
  const problems: string[] = [];
  const factIds = new Set(fact.edges.map((e) => e.id));
  const seen = new Map<string, string>(); // relationId -> 承载者

  const record = (rid: string, carrier: string) => {
    if (!factIds.has(rid)) problems.push(`invented ${rid} in ${carrier}`);
    else if (seen.has(rid)) problems.push(`duplicated ${rid}: ${seen.get(rid)} & ${carrier}`);
    else seen.set(rid, carrier);
  };
  for (const e of pres.edges) for (const rid of e.data.relationIds) record(rid, e.id);
  for (const n of pres.nodes) for (const rid of n.data.interiorRelationIds ?? []) record(rid, n.id);
  for (const rid of factIds) if (!seen.has(rid)) problems.push(`dropped ${rid}`);
  return problems; // 必须为 []
}
```

方向校验：对每条 trunk，抽查其 `relationIds` 对应的事实边，`proxy(source) === trunk.source` 必须成立——防止聚合时源汇写反。

## 4. ELK layered 配置

```ts
const layoutOptions = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",              // 嵌套图一次算完
  "elk.layered.spacing.nodeNodeBetweenLayers": "64",
  "elk.spacing.nodeNode": "32",
  "elk.spacing.edgeLabel": "12",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.layered.cycleBreaking.strategy": "GREEDY",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES", // 配合输入排序 → 确定性
};

const containerOptions = {
  ...layoutOptions,
  "elk.padding": "[top=44,left=16,bottom=16,right=16]",     // top 预留标题条，防子节点压标题
};
```

RF ↔ ELK 桥接：

```ts
async function runElk(pres: { nodes: PresNode[]; edges: PresEdge[] }) {
  const toElk = (n: PresNode): ElkNode => ({
    id: n.id,
    width: n.width ?? DEFAULT_W,     // 首帧用估算尺寸；useNodesInitialized 后用 node.measured 重跑一次
    height: n.height ?? DEFAULT_H,
    layoutOptions: n.type === "container" ? containerOptions : undefined,
    children: childrenOf(n.id, pres.nodes).map(toElk),
  });
  const graph = {
    id: "root", layoutOptions,
    children: pres.nodes.filter((n) => !n.parentId).map(toElk),
    edges: pres.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
  const res = await elk.layout(graph);
  return collectPositions(res);      // ELK 子坐标相对父节点，恰好对应 RF parentId 的相对定位，直接透传
}
```

布局触发收口在一个 hook：依赖只有 `presGraph`（即折叠集与分组的派生物）。hover/选中不在依赖里，物理上做不到交互触发布局。

```ts
function useLayout(pres: PresGraph) {
  useEffect(() => {
    let alive = true;
    layoutStore.getState().bumpLayoutRuns();     // 验证清单用的计数器
    runElk(pres).then((pos) => alive && layoutStore.getState().applyPositions(pos));
    return () => { alive = false; };
  }, [pres]);
}
```

## 5. 感知交叉的网格（外层）

**触发**：域容器数 ≥ 5，或 trunk 图环内边占比 > 30%：

```ts
const sccs = tarjanSCC(trunkGraph);
const cyclicEdgeRatio = trunks.filter((t) => inSameNontrivialSCC(t, sccs)).length / trunks.length;
const useGrid = domainCount >= 5 || cyclicEdgeRatio > 0.3;
```

**打分**：

```ts
const MAX_COLS = 4;

function score(cells: Map<string, Cell>, trunks: PresEdge[]): number {
  let length = 0;
  for (const t of trunks) length += t.data.weight * manhattan(cells.get(t.source)!, cells.get(t.target)!);
  const lambda = length / Math.max(1, trunks.length);        // 让两项同量级
  return length + lambda * countCrossings(cells, trunks);
}

function countCrossings(cells: Map<string, Cell>, trunks: PresEdge[]): number {
  // 容器中心连线的线段两两做规范相交测试（共享端点不计）
  let n = 0;
  for (let i = 0; i < trunks.length; i++)
    for (let j = i + 1; j < trunks.length; j++)
      if (!sharesEndpoint(trunks[i], trunks[j]) &&
          segmentsIntersect(seg(cells, trunks[i]), seg(cells, trunks[j]))) n++;
  return n;
}
```

**搜索**：域数 ≤ 8 全排列穷举（8! = 40320，打分廉价，毫秒级）；> 8 以加权度降序为初始解，贪心成对交换至无改进（上限 200 轮）。平手取字典序最小排列，保证确定性。

**两级组装**：

1. 每个容器内部单独跑 ELK layered → 得到容器内容尺寸；
2. 列宽 = 该列最大容器宽 + gutter，行高同理（网格不强制等大单元格）；
3. 容器定位到单元格，成员保持相对坐标（`parentId` 定位）不再变动。

对 ELK 方案与网格最优解**都算 score**，输出到控制台/报告后取小者——"选择有据"就是指这两个数字。

## 6. React Flow 渲染

```tsx
// nodeTypes/edgeTypes 必须引用稳定（模块级常量），否则 RF 整树重渲染
const nodeTypes = { container: ContainerNode, module: ModuleNode, infra: InfraNode } as const;
const edgeTypes = { precise: PreciseEdge, trunk: TrunkEdge } as const;

<ReactFlow
  nodes={nodes} edges={edges}
  nodeTypes={nodeTypes} edgeTypes={edgeTypes}
  onlyRenderVisibleElements                       // 大图视口裁剪
  fitView
  nodesConnectable={false} nodesDraggable={false} // 只读图：位置由布局引擎独占
/>
```

**Trunk 边**（数量徽标 + 对数粗细）：

```tsx
function TrunkEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 8 });
  const t = useOverlay(id);                        // 只订阅交互样式，见 §7
  return (
    <>
      <BaseEdge id={id} path={path}
        style={{ strokeWidth: 1 + Math.log2(1 + data.relationIds.length), opacity: t.dimmed ? 0.25 : 1 }}
        className={t.active ? "edge-accent" : "edge-neutral"} />
      {data.relationIds.length > 1 && (
        <EdgeLabelRenderer>
          <div className="trunk-badge"
               style={{ transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)` }}>
            {data.relationIds.length}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
```

**往返成对边**：渲染前按 `(min(source,target), max(source,target))` 分组，组内恰有两条反向边时各自加固定法向偏移，正负由 id 字典序决定（确定性，与交互无关）：

```ts
const offset = edge.source < edge.target ? +14 : -14;  // 控制点沿路径中垂线平移 offset
```

**容器折叠按钮**：点击只做一件事——`layoutStore.toggleCollapsed(id)`。派生、布局随之自动发生，组件内不得手搓 nodes/edges。

## 7. 状态分离（两个 store）

```ts
// layoutStore：改它 => 派生 + 重布局
interface LayoutState {
  collapsed: Set<string>;
  grouping: ContainerNode[];
  positions: Map<string, XY>;
  layoutRuns: number;                    // 验证清单断言用
  toggleCollapsed(id: string): void;
  applyMode(mode: "overview" | "focus" | "path", subject?: string[]): void; // 只是折叠集预设
}

// interactionStore：改它 => 只有样式变
interface InteractionState {
  hoveredId?: string;
  selectedIds: Set<string>;
  activePathIds: Set<string>;            // path 模式高亮的 relation ID 集
}
```

组件通过 `useOverlay(id)` 选择器订阅 interactionStore，返回 `{ dimmed, active, hovered }` 三个布尔；映射成 className / CSS 变量。**禁止**在交互回调里 setNodes/setEdges 改结构或坐标。

验证方法：Playwright 脚本 hover 全部节点 + 框选 + 取消，断言 `layoutStore.getState().layoutRuns` 前后相等。

## 8. 标签防碰撞实现要点

- 节点标签：`max-width` + `text-overflow` 中段省略（CSS 无原生中段省略，用 `label.slice(0, 12) + "…" + label.slice(-8)`），全名放 `title`。
- 容器标题：绝对定位在容器顶部 44px 条内（与 `elk.padding` 的 top 一致）。
- 徽标错位：`t = 0.5` 冲突时按 `hash(edge.id) % 2 ? 0.35 : 0.65` 取路径参数点——确定性，不随渲染帧变。
- 类型标签只在 focus 模式且边邻接主体时渲染；overview 一律不渲染逐边文字。

## 9. 性能

| 手段 | 说明 |
|---|---|
| worker 布局 | `workerFactory` 起 elk-worker，500+ 节点必开 |
| 视口裁剪 | `onlyRenderVisibleElements` |
| 引用稳定 | `nodeTypes` / `edgeTypes` / 回调全部模块级或 useMemo/useCallback |
| memo 节点组件 | 自定义节点 `memo()`，overlay 用选择器订阅避免全图重渲染 |
| 尺寸两段式 | 首帧估算尺寸布局一次，`useNodesInitialized` 后用 `node.measured` 精确重跑一次，之后不再因尺寸重排 |
| 折叠默认 | overview 是默认入口，精确边只在 focus/path 出现，DOM 数量受控 |

## 10. 视觉 token

```css
:root {
  --bg: #0d1117;
  --surface-module: rgba(22, 27, 34, 0.72);      /* 深色玻璃 */
  --border-module: rgba(240, 246, 252, 0.09);
  --surface-container: rgba(110, 118, 129, 0.06);
  --text: #e6edf3;  --text-dim: #8b949e;
  --edge-neutral: rgba(139, 148, 158, 0.35);
  --accent: #58a6ff;                              /* 全图唯一 accent，仅选中/激活 */
}
.node-module { background: var(--surface-module); backdrop-filter: blur(8px);
               border: 1px solid var(--border-module); border-radius: 8px; }
.node-infra  { background: transparent; border: 1.5px dashed var(--text-dim);
               border-radius: 12px; /* 图标按 infraKind 渲染，轮廓与模块卡片可区分 */ }
.edge-accent { stroke: var(--accent); }
.trunk-badge { background: var(--surface-module); color: var(--text-dim);
               border: 1px solid var(--border-module); border-radius: 999px;
               font-size: 10px; padding: 1px 6px; pointer-events: all; }
```

hover 提亮：`filter: brightness(1.25)`（中性），不碰 `--accent`。accent 审计：`document.querySelectorAll(".edge-accent,.node-accent").length` 必须等于选中/激活元素数。
