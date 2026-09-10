import assert from "node:assert/strict";
import test from "node:test";
import { buildAdjacency, chunkText, detectIntent } from "./chat";
import { loadDemoGraph } from "../seed/demoGraph";

test("意图识别覆盖契约 §4.6 的六类问题", () => {
  assert.equal(detectIntent("这个模块的功能是什么"), "responsibility");
  assert.equal(detectIntent("booking 被谁调用?"), "callers");
  assert.equal(detectIntent("它调用了哪些模块"), "callees");
  assert.equal(detectIntent("数据是怎么流转的"), "dataflow");
  assert.equal(detectIntent("修改这个模块会影响哪些组件"), "impact");
  assert.equal(detectIntent("哪些文档可能过期"), "docs");
  assert.equal(detectIntent("最新一次代码更新改了什么"), "recent");
  assert.equal(detectIntent("讲讲整体"), "overview");
});

test("邻接表基于 demo 图谱正确建立双向索引", () => {
  const graph = loadDemoGraph();
  const adj = buildAdjacency(graph);

  assert.equal(adj.byId.size, 20);

  const bookingOut = adj.outgoing.get("module:modules/booking") ?? [];
  const targets = new Set(bookingOut.map((e) => e.target));
  assert.ok(targets.has("module:modules/payment"), "booking 应调用 payment");
  assert.ok(targets.has("module:packages/event-bus"), "booking 应发布事件");

  const paymentIn = adj.incoming.get("module:modules/payment") ?? [];
  assert.ok(
    paymentIn.some((e) => e.source === "module:modules/booking"),
    "payment 的上游应含 booking",
  );

  // 推断关系必须能被识别出来（前端以暗绿色区别于确定性关系）
  const inferred = graph.edges.filter((e) => e.inferred);
  assert.equal(inferred.length, 2);
  assert.ok(inferred.every((e) => e.target === "module:modules/notification"));
});

test("chunkText 切段不丢内容", () => {
  const text = Array.from({ length: 12 }, (_, i) => `第 ${i} 行内容`).join("\n");
  const chunks = chunkText(text, 40);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), text);
  assert.deepEqual(chunkText(""), [""]);
});
