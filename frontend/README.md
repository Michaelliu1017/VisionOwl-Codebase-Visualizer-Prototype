# Visual Monitor Front-End Demo

M5 拨测本地闭环的纯前端可视化 Demo。当前使用模拟事件流，不读取或修改后端。

## 运行

```bash
npm install
npm run dev
```

默认地址：`http://127.0.0.1:4173/`

## 页面内容

- 完整链路：Console、TaskCenter、MySQL、Redis、Worker、Execution Queue、Agent-Rest、GoProbe、目标站点与报告存储。
- 实时动画：按注册、调度、拉取、探测、上报和落盘顺序循环播放。
- 节点详情：单击节点查看运行参数，再次单击或单击画布取消选择。
- 事件时间线：保留当前轮次的最近事件，支持暂停、单步、重播和调速。

模拟数据集中在 `src/mock-data.ts`，未来接入真实后端时可用 WebSocket 或 SSE 适配器替换 `useMonitorSimulation.ts`，图谱组件无需重写。
