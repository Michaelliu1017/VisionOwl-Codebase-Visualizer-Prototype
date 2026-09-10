import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvidenceSnapshot, RepositorySource } from "../domain/types.js";
import type { EvidenceStore } from "../storage/store.js";

export async function buildSnapshot(store: EvidenceStore, source: RepositorySource): Promise<EvidenceSnapshot> {
  if (!source.repositoryId || !source.externalRepositoryId || !source.defaultBranch) {
    throw new Error(`source ${source.id} is not resolved`);
  }
  const [nodes, edges, pendingLinks] = await Promise.all([
    store.listNodes(source.repositoryId),
    store.listEdges(source.repositoryId),
    store.listPendingLinks(source.repositoryId),
  ]);
  return {
    schemaVersion: "evidence.v1",
    repository: {
      sourceId: source.id,
      repositoryId: source.repositoryId,
      repoUrl: source.repoUrl,
      owner: source.owner,
      repo: source.repo,
      branch: source.branch ?? source.defaultBranch,
      commitSha: source.lastDefaultBranchSha,
    },
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
    pendingLinks,
    stats: {
      nodesByKind: countBy(nodes.map((node) => node.kind)),
      edgesByType: countBy(edges.map((edge) => edge.relationType)),
    },
  };
}

export async function writeSnapshot(snapshot: EvidenceSnapshot, dataDir: string): Promise<string> {
  const snapshotDir = join(dataDir, "snapshots", snapshot.repository.repositoryId.replaceAll(":", "_"));
  await mkdir(snapshotDir, { recursive: true });
  const version = snapshot.repository.commitSha?.slice(0, 12) ?? Date.now().toString();
  const snapshotPath = join(snapshotDir, `evidence-graph-${version}.json`);
  const latestPath = join(snapshotDir, "evidence-graph.json");
  const content = `${JSON.stringify(snapshot, null, 2)}\n`;
  await atomicWrite(snapshotPath, content);
  await atomicWrite(latestPath, content);
  return snapshotPath;
}

function countBy(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, path);
}
