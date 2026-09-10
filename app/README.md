# VisionOwl 桌面客户端

Electron + React + React Flow 实现的云端代码知识平台桌面端。设计与交互契约见根目录
`spec.md` §5,前后端协议见 `协同开发.md`。

## 启动

```bash
cd app
npm install          # 国内网络若 electron 下载失败,见下方说明
npm run dev          # 打开 Electron 窗口并连接真实 Cloud Backend
```

## 使用本地 Mock 数据

```bash
npm run dev:mock
```

`npm run dev` 与 `npm run dev:cloud` 都读取 `.env.production` 并连接真实后端。
Mock 只允许通过 `npm run dev:mock` 显式启用，避免把固定演示图谱误认为真实仓库分析结果。

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | 开发并连接真实 Cloud Backend |
| `npm run dev:mock` | 使用固定 Mock 数据开发界面 |
| `npm run typecheck` | 渲染层 + 主进程双份 tsc 检查 |
| `npm run build` | 产物输出到 `out/` |

## 国内网络说明

- `.npmrc` 已指向 npmmirror registry
- npm 11 不再向安装脚本透传 `electron_mirror`,若 `node_modules/electron/dist` 缺失:

```bash
cd node_modules/electron
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node install.js
```

- npm 11 的 allow-scripts 会拦截 electron/esbuild 的安装脚本,放行:
  `npm approve-scripts electron esbuild && npm rebuild electron esbuild`

## 目录

```
backend/    Electron 主进程(main.ts 窗口 / preload.ts 白名单桥)
frontend/   渲染层
  src/api/      契约类型 types.ts + 统一客户端 client.ts(Mock/HTTP 双实现)
  src/stores/   session / project / graph(单一权威选中态) / agent
  src/graph/    邻接索引 · elk 布局 · 边界锚点 · 轻校验
  src/components/
    canvas/     GraphCanvas(状态投影/域分组框/遮挡回退) + 节点 + 浮动边
    layout/     TopBar · SideTree · DetailPanel · StatusBar
    agent/      AgentConsole(mini ↔ 700×168 ↔ 拖高 60% 三态玻璃窗)
  src/mock/     canonical demo fixtures(与协同开发.md §8 一致)
```

## 快捷键

`` ` `` 呼出/收起 Agent 控制台 · `⌘J` 聚焦提问输入 · `Esc` 逐层清除(AI 高亮 → 选中)
