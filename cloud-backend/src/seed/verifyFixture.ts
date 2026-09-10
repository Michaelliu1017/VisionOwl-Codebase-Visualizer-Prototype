/**
 * fixture 自检（不连数据库，`npm run check` 的一环）
 * 断言 demo 图谱满足契约 §8.2 与 spec §8 校验规则，并且 evidence 路径真实存在。
 */
import fs from "node:fs";
import path from "node:path";
import { validateGraph } from "../schemas/graphValidator";
import { loadDemoGraph } from "./demoGraph";

const EXPECTED_NODES = 20;
const EXPECTED_EDGES = 34;
const EXPECTED_INFERRED = 2;
const EXPECTED_OVERVIEW_NODES = 17;

function repoRoot(): string {
  // cloud-backend/src/seed → 上溯 3 层到仓库根
  return path.resolve(__dirname, "..", "..", "..");
}

function main(): void {
  const graph = loadDemoGraph();
  const errors: string[] = [];

  if (graph.nodes.length !== EXPECTED_NODES) {
    errors.push(`节点数 ${graph.nodes.length} ≠ ${EXPECTED_NODES}`);
  }
  if (graph.edges.length !== EXPECTED_EDGES) {
    errors.push(`边数 ${graph.edges.length} ≠ ${EXPECTED_EDGES}`);
  }
  const inferred =
    graph.nodes.filter((n) => n.inferred).length + graph.edges.filter((e) => e.inferred).length;
  if (inferred !== EXPECTED_INFERRED) errors.push(`推断数 ${inferred} ≠ ${EXPECTED_INFERRED}`);

  const result = validateGraph(graph);
  errors.push(...result.errors);

  // evidence / path 必须真实存在于仓库（契约 §8.2）
  const root = repoRoot();
  const files = new Set<string>();
  for (const n of graph.nodes) {
    if (n.path) files.add(n.path);
    for (const ev of n.evidence ?? []) files.add(ev.file);
  }
  for (const e of graph.edges) for (const ev of e.evidence ?? []) files.add(ev.file);
  for (const f of files) {
    if (!fs.existsSync(path.join(root, f))) errors.push(`路径不存在于仓库：${f}`);
  }

  // 视图完整性
  const overview = graph.views?.find((v) => v.id === "overview");
  if (!overview) errors.push("缺少 overview 视图");
  else if (overview.nodeIds.length !== EXPECTED_OVERVIEW_NODES) {
    errors.push("overview 视图应覆盖全部顶层节点，并按需隐藏内部次级节点");
  }
  const flow = graph.views?.find((v) => v.id === "flow:place-booking");
  if (!flow) errors.push("缺少 flow:place-booking 视图");
  else if ((flow.steps ?? []).length !== 5) errors.push("下单流程视图必须有 5 个 step");

  if (errors.length > 0) {
    console.error("[verify:fixture] 失败：");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(
    `[verify:fixture] 通过：${graph.nodes.length} 节点 / ${graph.edges.length} 边 / ${inferred} 推断，` +
      `${files.size} 个路径全部存在`,
  );
}

main();
