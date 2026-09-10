/* 四个方案共用的外壳片段（header / agent / 方案标识条） */

const PLANS = [
  ['a', 'IDE 三栏 + 底部 Agent 坞'],
  ['b', '图谱优先 + 玻璃浮层'],
  ['c', '窄栏 + 右列堆叠'],
  ['d', 'Agent 主导工作台'],
];

function planBar(current) {
  const links = PLANS.map(([k, label]) =>
    k === current
      ? `<strong>方案 ${k.toUpperCase()} · ${label}</strong>`
      : `<a href="layout-${k}.html">方案 ${k.toUpperCase()}</a>`
  ).join('<span style="color:var(--dgg-line-strong)">/</span>');

  return `<div class="vo-plan-bar">${links}` +
    `<span style="margin-left:auto"><a href="index.html">← 全部方案</a></span></div>`;
}

function headerHTML(opts = {}) {
  const tabs = ['总体架构', '任务下发', '数据流向', '模块依赖']
    .map((t, i) =>
      `<div class="vo-tab${i === 0 ? ' is-active' : ''}">${t}</div>`
    ).join('');

  return `
<header class="dgg-header">
  <div class="vo-header__left">
    <div class="vo-logo">◎</div>
    <div class="vo-project">
      <span>team-046</span>
      <span class="vo-project__repo">alibaba-inc/team-046</span>
      <span style="color:var(--dgg-faint);font-size:9px">▾</span>
    </div>
    ${opts.hideTabs ? '' : `<div class="vo-tabs">${tabs}</div>`}
  </div>
  <div class="vo-header__right">
    <div class="vo-status"><span class="vo-dot"></span><span>已同步 · 171b8f0</span></div>
    <div class="vo-icon-btn" title="重新扫描">⟳</div>
    <div class="vo-icon-btn" title="设置">⚙</div>
  </div>
</header>`;
}

function agentHTML(opts = {}) {
  const head = opts.head === false ? '' :
    `<div class="vo-panel-title"><span>Agent</span>` +
    `<span style="color:var(--dgg-faint);font-size:10px">qoder · 就绪</span></div>`;

  return `
<div class="vo-agent" style="height:100%">
  ${head}
  <div class="vo-agent__log">
    <div class="vo-msg is-user">
      <div class="vo-msg__role">我</div>
      <div class="vo-msg__body">booking 为什么会依赖 payment？这是合理的吗</div>
    </div>
    <div class="vo-msg is-agent">
      <div class="vo-msg__role">Agent</div>
      <div class="vo-msg__body">
        booking 通过 <code>booking-payment-adapter.ts</code> 直接调用 payment
        的交易接口。这是一个跨业务模块的同步依赖，会让下单链路与支付可用性强耦合。
        建议改为经 event-bus 发布领域事件，由 payment 订阅处理。
        <div class="vo-msg__cite">依据 modules/booking/src/booking-payment-adapter.ts:24</div>
      </div>
    </div>
  </div>
  <div class="vo-agent__acts">
    <div class="vo-chip">分析此模块</div>
    <div class="vo-chip">生成钉钉文档</div>
    <div class="vo-chip">解释这条依赖</div>
    <div class="vo-chip">找出循环依赖</div>
  </div>
  <div class="vo-agent__input">
    <div class="vo-agent__field">对选中的模块提问…</div>
    <div class="vo-agent__send">发送</div>
  </div>
</div>`;
}

function canvasHTML(extra = '') {
  return `
<div class="dgg-canvas" data-canvas>
  <div class="vo-graph">
    <div class="vo-stage" data-stage></div>
  </div>
  <div class="vo-canvas-hint">点击节点高亮交互链路 · 点击空白取消 · Esc 清空</div>
  <div class="vo-canvas-tools">
    <div class="vo-icon-btn">＋</div>
    <div class="vo-icon-btn">－</div>
    <div class="vo-icon-btn">⤢</div>
  </div>
  ${extra}
</div>`;
}

function detailPanelHTML(title = '详情') {
  return `<div class="vo-panel-title"><span>${title}</span>` +
    `<span style="color:var(--dgg-faint);font-size:10px">⋯</span></div>` +
    `<div data-detail style="flex:1;overflow:auto"></div>`;
}

function boot() {
  const stage = document.querySelector('[data-stage]');
  if (stage) renderGraph(stage);
  const tree = document.querySelector('[data-tree]');
  if (tree) renderTree(tree);
}
