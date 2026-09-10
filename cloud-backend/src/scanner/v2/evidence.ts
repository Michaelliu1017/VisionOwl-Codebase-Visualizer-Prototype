import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type ts from "typescript";
import type { FactEvidence } from "./contracts";

function hashExcerpt(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function nodeEvidence(
  root: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  symbol?: string,
): FactEvidence {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  const excerpt = sourceFile.text.slice(node.getStart(sourceFile), Math.min(node.getEnd(), node.getStart(sourceFile) + 500));
  return {
    file: path.relative(root, sourceFile.fileName).split(path.sep).join("/"),
    startLine: start.line + 1,
    endLine: Math.min(end.line + 1, start.line + 40),
    symbol,
    excerptHash: hashExcerpt(excerpt),
  };
}

export function fileEvidence(root: string, relativeFile: string, symbol?: string): FactEvidence {
  const normalized = relativeFile.split(path.sep).join("/");
  let firstLine = "";
  try {
    firstLine = fs.readFileSync(path.join(root, normalized), "utf8").split("\n", 1)[0] ?? "";
  } catch {
    firstLine = normalized;
  }
  return {
    file: normalized,
    startLine: 1,
    endLine: 1,
    symbol,
    excerptHash: hashExcerpt(firstLine),
  };
}
