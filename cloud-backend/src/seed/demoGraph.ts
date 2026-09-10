/**
 * 演示图谱加载器。
 * `graph.demo.json` 是**两端唯一权威 demo 数据**（契约 §8）：
 * 桌面端 app/frontend/src/mock/fixtures/graph.demo.json 必须与本文件逐字节一致。
 */
import fs from "node:fs";
import path from "node:path";
import type { GraphDocument } from "../types";

const CANDIDATES = [
  path.join(__dirname, "graph.demo.json"),
  path.join(__dirname, "..", "..", "src", "seed", "graph.demo.json"),
];

export function demoGraphPath(): string {
  for (const p of CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error("找不到 graph.demo.json（构建时应由 scripts/copy-assets.mjs 拷入 dist）");
}

export function loadDemoGraph(): GraphDocument {
  return JSON.parse(fs.readFileSync(demoGraphPath(), "utf8")) as GraphDocument;
}
