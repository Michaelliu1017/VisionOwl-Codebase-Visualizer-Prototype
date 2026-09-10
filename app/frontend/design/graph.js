/* visionOwl 图谱引擎（方案原型共用）
 *
 * 严格实现 dark-glass-graph-ui 的交互契约：
 *  - 单一权威状态，邻接高亮是选中态的投影，边不自持高亮
 *  - 单击选中 / 单击他者切换 / 单击自身取消 / 单击空白清空
 *  - 相关节点保持正常亮度，仅无关节点变暗
 *  - 边界锚点连线，非中心到中心
 *  - 边渲染在节点之下，双路径（宽透明命中路径 + 可见路径）
 *
 * 图谱数据取自本仓库 test/ fixture 的真实模块结构。
 */

const NODE_W = 160;
const NODE_H = 58;

const NODES = [
  { id: 'app-web',    name: 'web',          path: 'apps/web',              type: 'app',     icon: '▤', summary: 'React 前端，消费 API 并渲染预订与目录页面。' },
  { id: 'app-api',    name: 'api',          path: 'apps/api',              type: 'app',     icon: '▤', summary: 'HTTP 入口，装配路由、中间件与依赖上下文。' },
  { id: 'app-worker', name: 'worker',       path: 'apps/worker',           type: 'app',     icon: '▤', summary: '后台消费者，处理事件总线上的异步任务。' },

  { id: 'booking',      name: 'booking',      path: 'modules/booking',      type: 'module',  icon: '◆', summary: '预订编排：库存校验、下单、与支付模块协同。' },
  { id: 'catalog',      name: 'catalog',      path: 'modules/catalog',      type: 'module',  icon: '◆', summary: '活动与场次目录，读多写少，带缓存层。' },
  { id: 'identity',     name: 'identity',     path: 'modules/identity',     type: 'module',  icon: '◆', summary: '用户身份、会话与权限判定。' },
  { id: 'payment',      name: 'payment',      path: 'modules/payment',      type: 'module',  icon: '◆', summary: '支付网关适配与交易状态机。' },
  { id: 'notification', name: 'notification', path: 'modules/notification', type: 'module',  icon: '◆', summary: '事件驱动的通知投递，订阅领域事件。' },
  { id: 'reporting',    name: 'reporting',    path: 'modules/reporting',    type: 'module',  icon: '◆', summary: '聚合报表查询，直读数据库并缓存结果。' },

  { id: 'pkg-contracts', name: 'contracts', path: 'packages/contracts', type: 'package', icon: '▢', summary: '跨模块共享的类型契约与事件定义。' },
  { id: 'pkg-database',  name: 'database',  path: 'packages/database',  type: 'package', icon: '▢', summary: '连接池、迁移与仓储基类。' },
  { id: 'pkg-event-bus', name: 'event-bus', path: 'packages/event-bus', type: 'package', icon: '▢', summary: '发布订阅抽象，解耦模块间通信。' },
  { id: 'pkg-cache',     name: 'cache',     path: 'packages/cache',     type: 'package', icon: '▢', summary: '读缓存封装，带失效策略。' },
  { id: 'pkg-shared',    name: 'shared',    path: 'packages/shared',    type: 'package', icon: '▢', summary: '基础工具、错误类型与日志。' },
];

const POS = {
  'app-web': [100, 30], 'app-api': [310, 30], 'app-worker': [520, 30],
  booking: [40, 165], catalog: [215, 165], identity: [390, 165], payment: [565, 165],
  notification: [215, 280], reporting: [390, 280],
  'pkg-contracts': [40, 400], 'pkg-database': [215, 400],
  'pkg-event-bus': [390, 400], 'pkg-cache': [565, 400],
  'pkg-shared': [300, 510],
};

const EDGES = [
  ['app-web', 'app-api'],
  ['app-api', 'booking'], ['app-api', 'catalog'], ['app-api', 'identity'],
  ['app-api', 'payment'], ['app-api', 'reporting'],
  ['app-worker', 'notification'], ['app-worker', 'pkg-event-bus'],
  ['booking', 'payment'], ['booking', 'pkg-contracts'], ['booking', 'pkg-database'],
  ['booking', 'pkg-event-bus'],
  ['catalog', 'pkg-database'], ['catalog', 'pkg-cache'], ['catalog', 'pkg-contracts'],
  ['identity', 'pkg-database'], ['identity', 'pkg-contracts'],
  ['payment', 'pkg-contracts'], ['payment', 'pkg-database'],
  ['notification', 'pkg-contracts'], ['notification', 'pkg-event-bus'],
  ['reporting', 'pkg-database'], ['reporting', 'pkg-cache'],
  ['pkg-cache', 'pkg-shared'], ['pkg-database', 'pkg-shared'],
  ['pkg-event-bus', 'pkg-contracts'],
];

const TYPE_LABEL = { app: '应用', module: '业务模块', package: '共享包' };

/* 转义：正式版 graph.json 由 agent 分析任意仓库生成，节点名与摘要属于不可信输入。
 * Electron 渲染进程中的 XSS 可升级为 RCE，因此所有数据派生字符串必须经此处理。 */
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ---------- 邻接索引：数据变化时构建一次 ---------- */

const adjacency = new Map();
NODES.forEach(n => adjacency.set(n.id, { nodeIds: new Set(), edgeIds: new Set() }));
EDGES.forEach(([s, t], i) => {
  const id = `e${i}`;
  adjacency.get(s).nodeIds.add(t);
  adjacency.get(s).edgeIds.add(id);
  adjacency.get(t).nodeIds.add(s);
  adjacency.get(t).edgeIds.add(id);
});

const nodeById = new Map(NODES.map(n => [n.id, n]));

/* ---------- 单一权威状态 ---------- */

const state = { selectedNodeId: undefined };

/* ---------- 边界锚点：中心射线与节点矩形求交 ---------- */

function anchor(from, to) {
  const [fx, fy] = POS[from], [tx, ty] = POS[to];
  const c1 = { x: fx + NODE_W / 2, y: fy + NODE_H / 2 };
  const c2 = { x: tx + NODE_W / 2, y: ty + NODE_H / 2 };
  const dx = c2.x - c1.x, dy = c2.y - c1.y;

  const cut = (c, sx, sy) => {
    if (sx === 0 && sy === 0) return c;
    const hw = NODE_W / 2, hh = NODE_H / 2;
    const scale = Math.min(
      sx === 0 ? Infinity : hw / Math.abs(sx),
      sy === 0 ? Infinity : hh / Math.abs(sy)
    );
    return { x: c.x + sx * scale, y: c.y + sy * scale };
  };

  return { a: cut(c1, dx, dy), b: cut(c2, -dx, -dy) };
}

function edgePath(from, to) {
  const { a, b } = anchor(from, to);
  const midY = (a.y + b.y) / 2;
  // 竖直方向为主时走正交折线，更像依赖图；否则直连
  if (Math.abs(b.y - a.y) > 30) {
    return `M ${a.x} ${a.y} L ${a.x} ${midY} L ${b.x} ${midY} L ${b.x} ${b.y}`;
  }
  return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
}

/* ---------- 渲染 ---------- */

function renderGraph(canvasEl) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'vo-edges');
  svg.setAttribute('viewBox', '0 0 740 600');

  const defs = document.createElementNS(svgNS, 'defs');
  defs.innerHTML =
    '<marker id="vo-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6"' +
    ' markerHeight="6" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="currentColor"/></marker>';
  svg.appendChild(defs);

  EDGES.forEach(([s, t], i) => {
    const g = document.createElementNS(svgNS, 'g');
    g.setAttribute('class', 'dgg-edge');
    g.dataset.edgeId = `e${i}`;

    const d = edgePath(s, t);
    const hit = document.createElementNS(svgNS, 'path');
    hit.setAttribute('class', 'dgg-edge__hit');
    hit.setAttribute('d', d);

    const vis = document.createElementNS(svgNS, 'path');
    vis.setAttribute('class', 'dgg-edge__path');
    vis.setAttribute('d', d);
    vis.setAttribute('marker-end', 'url(#vo-arrow)');

    g.append(hit, vis);
    svg.appendChild(g);
  });

  canvasEl.appendChild(svg);

  const layer = document.createElement('div');
  layer.className = 'vo-nodes';

  NODES.forEach(n => {
    const [x, y] = POS[n.id];
    const slot = document.createElement('div');
    slot.className = 'vo-node-slot';
    slot.style.left = `${x}px`;
    slot.style.top = `${y}px`;

    const node = document.createElement('div');
    node.className = 'dgg-node';
    node.tabIndex = 0;
    node.dataset.nodeId = n.id;
    node.innerHTML =
      `<div class="dgg-node__surface">` +
      `<div class="dgg-node__icon">${esc(n.icon)}</div>` +
      `<div class="dgg-node__copy"><strong>${esc(n.name)}</strong>` +
      `<span>${esc(n.path)}</span></div>` +
      `</div>`;

    // 阻止冒泡，避免 canvas 处理器立刻清空选中
    node.addEventListener('click', e => { e.stopPropagation(); selectNode(n.id); });
    node.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectNode(n.id); }
    });

    slot.appendChild(node);
    layer.appendChild(slot);
  });

  canvasEl.appendChild(layer);
  canvasEl.addEventListener('click', clearSelection);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') clearSelection(); });

  applyState();
}

/* ---------- 状态迁移 ---------- */

function selectNode(id) {
  state.selectedNodeId = state.selectedNodeId === id ? undefined : id;
  applyState();
}

function clearSelection() {
  state.selectedNodeId = undefined;
  applyState();
}

function applyState() {
  const sel = state.selectedNodeId;
  const rel = sel ? adjacency.get(sel) : null;

  document.querySelectorAll('.dgg-node').forEach(el => {
    const id = el.dataset.nodeId;
    el.classList.toggle('is-selected', id === sel);
    el.classList.toggle('is-related', !!rel && rel.nodeIds.has(id));
    // 相关与选中永不被降亮规则覆盖
    el.classList.toggle(
      'is-dimmed',
      !!sel && id !== sel && !rel.nodeIds.has(id)
    );
  });

  document.querySelectorAll('.dgg-edge').forEach(el => {
    el.classList.toggle('is-related', !!rel && rel.edgeIds.has(el.dataset.edgeId));
  });

  document.querySelectorAll('.vo-tree__item').forEach(el => {
    el.classList.toggle('is-active', el.dataset.nodeId === sel);
  });

  renderDetail(sel ? nodeById.get(sel) : null);
  if (typeof onSelectionChange === 'function') onSelectionChange(sel);
}

/* ---------- 详情面板 ---------- */

function renderDetail(node) {
  const host = document.querySelector('[data-detail]');
  if (!host) return;

  if (!node) {
    host.innerHTML =
      '<div class="vo-empty">未选中模块<br><span style="font-size:10.5px">' +
      '点击图谱中任一节点查看详情与交互链路</span></div>';
    return;
  }

  const adj = adjacency.get(node.id);
  const out = EDGES.filter(([s]) => s === node.id).map(([, t]) => t);
  const inc = EDGES.filter(([, t]) => t === node.id).map(([s]) => s);

  const deps = list => list.length
    ? list.map(id => {
        const n = nodeById.get(id);
        return `<div class="vo-dep"><span class="vo-dep__arrow">→</span>` +
               `<span>${esc(n.name)}</span></div>`;
      }).join('')
    : '<div class="vo-dep" style="color:var(--dgg-faint)">无</div>';

  host.innerHTML =
    `<div class="vo-detail__head">` +
      `<div class="vo-detail__name">${esc(node.name)}</div>` +
      `<div class="vo-detail__path">${esc(node.path)}</div>` +
      `<div class="vo-badge">${esc(TYPE_LABEL[node.type])}</div>` +
    `</div>` +
    `<div class="vo-panel-body" style="color:var(--dgg-muted);line-height:1.6">` +
      `${esc(node.summary)}</div>` +
    `<div style="padding:0 12px 10px">` +
      `<div class="vo-kv"><span class="vo-kv__k">直接依赖</span>` +
        `<span class="vo-kv__v">${out.length}</span></div>` +
      `<div class="vo-kv"><span class="vo-kv__k">被依赖</span>` +
        `<span class="vo-kv__v">${inc.length}</span></div>` +
      `<div class="vo-kv"><span class="vo-kv__k">邻接节点</span>` +
        `<span class="vo-kv__v">${adj.nodeIds.size}</span></div>` +
    `</div>` +
    `<div class="vo-section">依赖 (${out.length})</div>${deps(out)}` +
    `<div class="vo-section">被依赖 (${inc.length})</div>${deps(inc)}` +
    `<div class="vo-section">挂载文档</div>` +
    `<div class="vo-dep"><span class="vo-dep__arrow">◎</span>` +
      `<span>${esc(node.name)} 设计说明.doc</span></div>`;
}

/* ---------- 左侧树 ---------- */

function renderTree(host) {
  const groups = [
    ['应用', NODES.filter(n => n.type === 'app')],
    ['业务模块', NODES.filter(n => n.type === 'module')],
    ['共享包', NODES.filter(n => n.type === 'package')],
  ];
  host.innerHTML = groups.map(([label, items]) =>
    `<div class="vo-tree__group">${label}</div>` +
    items.map(n =>
      `<div class="vo-tree__item" data-node-id="${esc(n.id)}">` +
      `<span class="vo-tree__kind"></span><span>${esc(n.name)}</span></div>`
    ).join('')
  ).join('');

  host.querySelectorAll('.vo-tree__item').forEach(el => {
    el.addEventListener('click', () => selectNode(el.dataset.nodeId));
  });
}

let onSelectionChange = null;
