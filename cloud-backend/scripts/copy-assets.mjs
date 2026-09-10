/**
 * 构建后拷贝非 TS 资源到 dist（JSON schema、demo 图谱）。
 * tsc 不会搬运这些文件，运行时按 __dirname 查找。
 */
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const ASSETS = [
  ["src/schemas/graph.schema.json", "dist/schemas/graph.schema.json"],
  ["src/schemas/graph-patch.schema.json", "dist/schemas/graph-patch.schema.json"],
  ["src/seed/graph.demo.json", "dist/seed/graph.demo.json"],
];

for (const [from, to] of ASSETS) {
  const dest = path.join(ROOT, to);
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(path.join(ROOT, from), dest);
  console.log(`[copy-assets] ${from} → ${to}`);
}
