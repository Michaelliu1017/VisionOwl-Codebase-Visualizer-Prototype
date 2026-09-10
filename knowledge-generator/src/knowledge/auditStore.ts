import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KnowledgeRunCommand } from "../codegraph/types.js";
import type { PublishedAsset } from "../core/types.js";
import type { KnowledgeContext } from "./types.js";

/** Local audit output is operational evidence only; Core remains the source of truth. */
export class KnowledgeAuditStore {
  constructor(private readonly root: string) {}

  async writeContext(command: KnowledgeRunCommand, context: KnowledgeContext): Promise<void> {
    const dir = await this.runDir(command.runId);
    await Promise.all([
      writeJson(join(dir, "command.json"), redactCommand(command)),
      writeJson(join(dir, "evidence-links.json"), context.linked),
      writeJson(join(dir, "semantic-knowledge.json"), context.semantic),
      writeJson(join(dir, "summary.json"), {
        runId: command.runId,
        projectId: command.projectId,
        graphVersionId: command.graphVersionId,
        graphVersionNo: command.graphVersionNo,
        repositories: command.repositorySnapshots,
        graph: { nodes: context.graph.nodes.length, edges: context.graph.edges.length },
        evidence: context.repositories.map((item) => ({
          repository: item.repository.repoFullName,
          commitSha: item.repository.commitSha,
          nodes: item.snapshot.nodes.length,
          edges: item.snapshot.edges.length,
        })),
        links: context.linked.stats,
        semanticProvider: context.semantic.provider,
        warnings: context.semantic.warnings,
      }),
    ]);
  }

  async writePublished(runId: string, artifacts: PublishedAsset[]): Promise<void> {
    const dir = await this.runDir(runId);
    await writeJson(join(dir, "published-artifacts.json"), artifacts);
  }

  async writeFailure(runId: string, error: string): Promise<void> {
    const dir = await this.runDir(runId);
    await writeJson(join(dir, "failure.json"), { runId, error, failedAt: new Date().toISOString() });
  }

  private async runDir(runId: string): Promise<string> {
    const safe = runId.replace(/[^A-Za-z0-9_-]/g, "_");
    const dir = join(this.root, safe);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function redactCommand(command: KnowledgeRunCommand): KnowledgeRunCommand {
  return structuredClone(command);
}
