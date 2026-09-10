import { createHash } from "node:crypto";

export function stableHash(...parts: Array<string | number | null | undefined>): string {
  return createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\u001f"))
    .digest("hex")
    .slice(0, 20);
}

export function scopedId(repositoryId: string, kind: string, value: string): string {
  const safeRepository = repositoryId.replace(/[^A-Za-z0-9._/-]/g, "_");
  const safeValue = value.replaceAll("\\", "/").replace(/^\.\//, "");
  return `${kind}:${safeRepository}:${safeValue}`;
}

export function factId(
  repositoryId: string,
  type: string,
  subjectId: string,
  relation: string | undefined,
  objectId: string | undefined,
  file: string,
  line: number,
): string {
  return `fact:${stableHash(repositoryId, type, subjectId, relation, objectId, file, line)}`;
}
