import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { KnowledgeRunCommand } from "../../src/codegraph/types.js";
import type {
  CoreIntegrationPort,
  ProgressUpdate,
  PublishedAsset,
  UploadedArtifact,
} from "../../src/core/types.js";
import { KnowledgeAuditStore } from "../../src/knowledge/auditStore.js";
import type { EvidenceProviderPort } from "../../src/knowledge/evidenceProvider.js";
import { KnowledgeRunProcessor } from "../../src/knowledge/processor.js";
import { DeterministicSemanticAnalyzer } from "../../src/knowledge/semantic.js";
import {
  knowledgeCommand,
  knowledgeEvidenceInput,
  knowledgeGraph,
} from "../fixtures/knowledgeFixture.js";

test("runs the frozen graph to Wiki and Skills publication contract end to end", async () => {
  const auditDir = await mkdtemp(join(tmpdir(), "knowledge-processor-test-"));
  const core = new FakeCore();
  const evidence: EvidenceProviderPort = { collect: async () => [knowledgeEvidenceInput] };
  const processor = new KnowledgeRunProcessor({
    core,
    evidence,
    semantic: new DeterministicSemanticAnalyzer(),
    audit: new KnowledgeAuditStore(auditDir),
  });
  try {
    const result = await processor.process(knowledgeCommand.runId);
    assert.equal(result.status, "succeeded");
    assert.equal(core.failure, undefined);
    assert.equal(core.completed.length, 2);
    assert.deepEqual(core.completed.map((item) => item.kind).sort(), ["skills", "wiki"]);
    assert.equal(core.progress.some((item) => item.stage === "linking"), true);
    assert.equal(core.progress.some((item) => item.status === "publishing"), true);

    for (const asset of core.completed) {
      const bundle = core.byArtifactKey.get(asset.bundleArtifactKey);
      const manifestContent = core.byArtifactKey.get(asset.manifestArtifactKey);
      assert.ok(bundle);
      assert.ok(manifestContent);
      assert.equal(sha256(bundle), asset.checksum);
      const manifest = JSON.parse(manifestContent.toString("utf8"));
      assert.equal(manifest.kind, asset.kind);
      assert.equal(manifest.files.length > 1, true);
      assert.equal(manifest.files.every((file: { artifactKey: string }) => core.byArtifactKey.has(file.artifactKey)), true);
    }

    const wikiManifest = JSON.parse(core.uploads.get("wiki-manifest.json")!.toString("utf8"));
    assert.equal(wikiManifest.files.some((file: { path: string }) => file.path.includes("modules/")), true);
    const skillsManifest = JSON.parse(core.uploads.get("skills-manifest.json")!.toString("utf8"));
    assert.equal(skillsManifest.files.some((file: { path: string }) => file.path.endsWith("/SKILL.md")), true);
    const datasetEntry = skillsManifest.files.find((file: { path: string }) => file.path === "evaluation/dataset.json");
    assert.ok(datasetEntry);
    const dataset = JSON.parse(core.byArtifactKey.get(datasetEntry.artifactKey)!.toString("utf8"));
    assert.equal(dataset.schemaVersion, "evaluation-dataset.v1");
    assert.equal(dataset.usable, true);
    assert.equal(dataset.developmentTasks.length, 1);
    assert.equal(dataset.validationTasks.length, 1);
    for (const task of [...dataset.developmentTasks, ...dataset.validationTasks]) {
      assert.match(task.baseSha, /^[0-9a-f]{40}$/);
      assert.match(task.metadata.headSha, /^[0-9a-f]{40}$/);
      assert.equal(task.allowedPaths.length > 0, true);
    }
  } finally {
    await rm(auditDir, { recursive: true, force: true });
  }
});

class FakeCore implements CoreIntegrationPort {
  progress: ProgressUpdate[] = [];
  uploads = new Map<string, Buffer>();
  byArtifactKey = new Map<string, Buffer>();
  completed: PublishedAsset[] = [];
  failure?: string;

  async getCommand(runId: string): Promise<KnowledgeRunCommand> {
    assert.equal(runId, knowledgeCommand.runId);
    return structuredClone(knowledgeCommand);
  }

  async getGraph(): Promise<unknown> {
    return structuredClone(knowledgeGraph);
  }

  async updateProgress(_command: KnowledgeRunCommand, update: ProgressUpdate): Promise<void> {
    this.progress.push(update);
  }

  async uploadArtifact(
    _command: KnowledgeRunCommand,
    fileName: string,
    content: Buffer,
  ): Promise<UploadedArtifact> {
    const copy = Buffer.from(content);
    const artifactKey = `visionowl/project-1/integrations/run-1/${fileName}`;
    this.uploads.set(fileName, copy);
    this.byArtifactKey.set(artifactKey, copy);
    return { artifactKey, checksum: sha256(copy), size: copy.length };
  }

  async complete(_command: KnowledgeRunCommand, artifacts: PublishedAsset[]): Promise<void> {
    this.completed = structuredClone(artifacts);
  }

  async fail(_runId: string, error: string): Promise<void> {
    this.failure = error;
  }
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
