import assert from "node:assert/strict";
import test from "node:test";
import {
  assetManifestSchema,
  knowledgeCompleteBody,
  skillLabCompleteBody,
} from "../schemas/knowledge";
import { knowledgeAssetVersionStatus } from "./knowledge";

const checksum = "a".repeat(64);

test("knowledge manifest accepts a traceable markdown asset", () => {
  const parsed = assetManifestSchema.safeParse({
    schemaVersion: "1.0",
    kind: "wiki",
    title: "Engineering Wiki",
    files: [{
      id: "architecture",
      title: "Architecture",
      path: "architecture.md",
      artifactKey: "visionowl/integrations/project/run/architecture.md",
      mediaType: "text/markdown; charset=utf-8",
      sha256: checksum,
    }],
  });
  assert.equal(parsed.success, true);
});

test("knowledge completion rejects duplicate or empty outputs", () => {
  assert.equal(knowledgeCompleteBody.safeParse({ artifacts: [] }).success, false);
  assert.equal(
    knowledgeCompleteBody.safeParse({
      artifacts: [{
        kind: "wiki",
        bundleArtifactKey: "bundle.zip",
        manifestArtifactKey: "manifest.json",
        checksum: "not-a-checksum",
      }],
    }).success,
    false,
  );
});

test("skill lab cannot publish a wiki as optimized output", () => {
  const parsed = skillLabCompleteBody.safeParse({
    decision: "accepted",
    scores: { overall: 0.91 },
    output: {
      kind: "wiki",
      bundleArtifactKey: "bundle.zip",
      manifestArtifactKey: "manifest.json",
      checksum,
    },
  });
  assert.equal(parsed.success, false);
});

test("first skill is published while later skill versions enter Skill Lab", () => {
  assert.equal(knowledgeAssetVersionStatus("wiki", false), "published");
  assert.equal(knowledgeAssetVersionStatus("wiki", true), "published");
  assert.equal(knowledgeAssetVersionStatus("skills", false), "published");
  assert.equal(knowledgeAssetVersionStatus("skills", true), "candidate");
});
