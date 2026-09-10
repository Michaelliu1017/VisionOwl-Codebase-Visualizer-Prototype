import { createHash } from "node:crypto";

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function repositoryEvidenceId(externalRepositoryId: string): string {
  return `github:${externalRepositoryId}:repository:${externalRepositoryId}`;
}

export function evidenceId(
  externalRepositoryId: string,
  kind: string,
  externalId: string | number,
): string {
  return `github:${externalRepositoryId}:${kind}:${String(externalId)}`;
}

export function actorId(externalRepositoryId: string, externalActorId: string | number): string {
  return evidenceId(externalRepositoryId, "actor", externalActorId);
}

export function fileId(externalRepositoryId: string, path: string): string {
  return evidenceId(externalRepositoryId, "file", encodeURIComponent(normalizeRepoPath(path)));
}

export function fileChangeId(
  externalRepositoryId: string,
  scope: "commit" | "pr",
  scopeId: string | number,
  path: string,
): string {
  return evidenceId(
    externalRepositoryId,
    "file_change",
    `${scope}:${String(scopeId)}:${sha256(normalizeRepoPath(path)).slice(0, 16)}`,
  );
}

export function edgeId(fromId: string, relationType: string, toId: string): string {
  return `edge:${sha256(`${fromId}|${relationType}|${toId}`)}`;
}

export function pendingLinkId(fromId: string, relationType: string, expectedToId: string): string {
  return `pending:${sha256(`${fromId}|${relationType}|${expectedToId}`)}`;
}

export function rawRecordId(
  externalRepositoryId: string,
  resourceType: string,
  externalId: string | number,
  checksum: string,
): string {
  return `raw:${sha256(`${externalRepositoryId}|${resourceType}|${String(externalId)}|${checksum}`)}`;
}

export function normalizeRepoPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
}
