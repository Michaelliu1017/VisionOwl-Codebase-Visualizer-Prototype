import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildGraphSkeleton, collectFacts, computeImpact } from "./scan";
import { validateGraph } from "../schemas/graphValidator";

/** 以仓库内的 EventHub fixture（test/，只读）为扫描对象 */
const FIXTURE = path.resolve(__dirname, "..", "..", "..", "test");
const fixtureTest = fs.existsSync(path.join(FIXTURE, "package.json")) ? test : test.skip;

fixtureTest("扫描 EventHub fixture：识别 workspace 模块与基础设施", () => {
  const facts = collectFacts(FIXTURE);

  // 3 apps + 6 modules + 5 packages
  assert.equal(facts.modules.length, 14, `实际 ${facts.modules.length} 个模块`);
  const ids = new Set(facts.modules.map((m) => m.nodeId));
  for (const expected of [
    "module:apps/api",
    "module:apps/web",
    "module:apps/worker",
    "module:modules/booking",
    "module:modules/payment",
    "module:packages/database",
    "module:packages/cache",
  ]) {
    assert.ok(ids.has(expected), `缺少模块节点 ${expected}`);
  }

  // 基础设施引用来自真实 import（pg / redis）
  const infraNodes = new Set(facts.infraRefs.map((r) => r.nodeId));
  assert.ok(infraNodes.has("infra:postgres"), "未识别 PostgreSQL");
  assert.ok(infraNodes.has("infra:redis"), "未识别 Redis");

  // 顶层模块内部只抽取稳定的一层代码分区，供前端按需展开。
  const submoduleIds = new Set(facts.submodules.map((item) => item.nodeId));
  assert.ok(submoduleIds.has("submodule:apps/api/src/routes"), "未识别 API routes 次级模块");
  assert.ok(submoduleIds.has("submodule:apps/api/src/middleware"), "未识别 API middleware 次级模块");
});

fixtureTest("骨架图通过 spec §8 校验，且关系来自真实 import", () => {
  const facts = collectFacts(FIXTURE);
  const graph = buildGraphSkeleton(facts, "test-project", "abc1234");

  const result = validateGraph(graph);
  assert.equal(result.ok, true, `校验失败：${result.errors.join("; ")}`);
  assert.equal(result.stats.inferredCount, 0, "确定性扫描不得产出推断结论");

  const edgeIds = new Set(graph.edges.map((e) => e.id));
  assert.ok(
    edgeIds.has("e:module:modules/booking->module:packages/contracts:dependency"),
    "缺少 booking → contracts 依赖",
  );
  assert.ok(
    edgeIds.has("e:module:packages/database->infra:postgres:write"),
    "缺少 database → PostgreSQL 写关系",
  );
  assert.ok(
    edgeIds.has("e:module:apps/api->submodule:apps/api/src/routes:contains"),
    "缺少 api → routes 内部包含关系",
  );

  const routes = graph.nodes.find((node) => node.id === "submodule:apps/api/src/routes");
  assert.equal(routes?.parentId, "module:apps/api");
  assert.equal(routes?.kind, "submodule");
  const overview = graph.views?.find((view) => view.id === "overview");
  assert.ok(!overview?.nodeIds.includes(routes!.id), "次级节点不应默认铺在总览中");

  // 每条非推断边都必须带证据（spec §8 规则 2）
  for (const e of graph.edges) {
    assert.ok((e.evidence ?? []).length > 0, `边 ${e.id} 缺少 evidence`);
    assert.ok(e.evidence![0]!.file.length > 0);
  }

  // 骨架可复现：同一输入两次产出的节点/边集合一致
  const again = buildGraphSkeleton(collectFacts(FIXTURE), "test-project", "abc1234");
  assert.deepEqual(
    again.nodes.map((n) => n.id),
    graph.nodes.map((n) => n.id),
  );
  assert.deepEqual(
    again.edges.map((e) => e.id),
    graph.edges.map((e) => e.id),
  );
});

fixtureTest("增量：变更文件映射到受影响模块及一层邻接", () => {
  const graph = buildGraphSkeleton(collectFacts(FIXTURE), "test-project", "abc1234");
  const impact = computeImpact(graph, ["modules/booking/src/create-booking.ts"]);

  assert.ok(impact.affectedNodeIds.includes("module:modules/booking"), "直接受影响模块缺失");
  assert.ok(impact.affectedNodeIds.length > 1, "应包含邻接闭包");
  assert.equal(impact.globalStructureChanged, false);

  const rootChange = computeImpact(graph, ["package.json"]);
  assert.equal(rootChange.globalStructureChanged, true, "根依赖清单变化应视为全局结构变化");
});

test("普通 Python/HTML 仓库无需根 package.json 也能发现模块", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "visionowl-generic-"));
  try {
    fs.mkdirSync(path.join(repo, "app", "backend"), { recursive: true });
    fs.mkdirSync(path.join(repo, "app", "frontend"), { recursive: true });
    fs.writeFileSync(path.join(repo, "app", "backend", "requirements.txt"), "fastapi\n");
    fs.writeFileSync(path.join(repo, "app", "backend", "main.py"), "from fastapi import FastAPI\n");
    fs.writeFileSync(path.join(repo, "app", "frontend", "index.html"), "<main>demo</main>\n");

    const facts = collectFacts(repo);
    const ids = new Set(facts.modules.map((module) => module.nodeId));
    assert.ok(ids.has("module:app/backend"));
    assert.ok(ids.has("module:app/frontend"));
    assert.equal(facts.fileCount, 2);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
