import { z } from "zod";

const uuid = z.string().uuid();
const artifactKey = z.string().trim().min(1).max(1200);
const checksum = z.string().trim().regex(/^[a-f0-9]{64}$/i, "checksum 必须是 SHA-256");

export const knowledgeAssetKindSchema = z.enum(["wiki", "skills"]);

export const createKnowledgeRunBody = z.object({
  requestedAssets: z.array(knowledgeAssetKindSchema).min(1).max(2).default(["wiki", "skills"]),
  force: z.boolean().default(false),
});

export const knowledgeAssetParam = z.object({ id: uuid, assetId: uuid });
export const knowledgeRunParam = z.object({ id: uuid, runId: uuid });
export const internalRunParam = z.object({ runId: uuid });
export const skillLabRepositoryParam = z.object({
  runId: uuid,
  bindingId: uuid,
});
export const skillLabRepositoryQuery = z.object({
  sha: z.string().regex(/^[0-9a-fA-F]{7,64}$/, "sha 必须是 commit id"),
});
export const assetContentQuery = z.object({ path: z.string().trim().min(1).max(1000) });

export const integrationProgressBody = z.object({
  status: z.enum(["running", "publishing", "evaluating", "optimizing", "validating"]),
  progress: z.number().int().min(0).max(99),
  stage: z.string().trim().min(1).max(100).optional(),
  note: z.string().trim().max(1000).optional(),
});

export const integrationFailureBody = z.object({
  error: z.string().trim().min(1).max(2000),
});

export const assetManifestEntrySchema = z.object({
  id: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(300),
  path: z.string().trim().min(1).max(1000),
  artifactKey,
  mediaType: z.string().trim().min(1).max(200).default("text/markdown; charset=utf-8"),
  size: z.number().int().nonnegative().optional(),
  sha256: checksum.optional(),
});

export const assetManifestSchema = z.object({
  schemaVersion: z.literal("1.0"),
  kind: knowledgeAssetKindSchema,
  title: z.string().trim().min(1).max(300),
  files: z.array(assetManifestEntrySchema).max(5000),
});

export type AssetManifest = z.infer<typeof assetManifestSchema>;

export const incomingAssetSchema = z.object({
  kind: knowledgeAssetKindSchema,
  bundleArtifactKey: artifactKey,
  manifestArtifactKey: artifactKey,
  checksum,
  summary: z.record(z.unknown()).default({}),
});

export type IncomingAsset = z.infer<typeof incomingAssetSchema>;

export const knowledgeCompleteBody = z.object({
  artifacts: z.array(incomingAssetSchema).min(1).max(2),
});

export const skillLabCompleteBody = z
  .object({
    decision: z.enum(["accepted", "rejected"]),
    scores: z.record(z.unknown()).default({}),
    reportArtifactKey: artifactKey.optional(),
    diffArtifactKey: artifactKey.optional(),
    output: incomingAssetSchema.optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.output && value.output.kind !== "skills") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["output", "kind"], message: "Skill Lab 只能输出 skills" });
    }
  });

export const integrationArtifactParam = z.object({
  runId: uuid,
  fileName: z.string().regex(/^[A-Za-z0-9._-]{1,180}$/, "fileName 含非法字符"),
});
