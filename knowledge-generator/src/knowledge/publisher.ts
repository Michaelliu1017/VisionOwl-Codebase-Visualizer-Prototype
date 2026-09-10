import { createHash } from "node:crypto";
import { createZip } from "../artifacts/zip.js";
import type { KnowledgeRunCommand } from "../codegraph/types.js";
import type { AssetManifest, CoreIntegrationPort, PublishedAsset } from "../core/types.js";
import type { GeneratedKnowledgeAsset, KnowledgeFile } from "./types.js";

export class KnowledgePublisher {
  constructor(private readonly core: CoreIntegrationPort) {}

  async publish(
    command: KnowledgeRunCommand,
    assets: GeneratedKnowledgeAsset[],
  ): Promise<PublishedAsset[]> {
    const published: PublishedAsset[] = [];
    for (const asset of assets) published.push(await this.publishAsset(command, asset));
    return published;
  }

  private async publishAsset(
    command: KnowledgeRunCommand,
    asset: GeneratedKnowledgeAsset,
  ): Promise<PublishedAsset> {
    validateAsset(asset);
    const files = [];
    for (const file of asset.files) {
      const uploaded = await this.core.uploadArtifact(
        command,
        artifactFileName(asset.kind, file),
        file.content,
      );
      files.push({
        id: file.id,
        title: file.title,
        path: file.path,
        artifactKey: uploaded.artifactKey,
        mediaType: file.mediaType,
        size: file.content.length,
        sha256: sha256(file.content),
      });
    }

    const manifest: AssetManifest = {
      schemaVersion: "1.0",
      kind: asset.kind,
      title: asset.title,
      files,
    };
    const manifestContent = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const bundle = createZip([
      ...asset.files.map((file) => ({ path: file.path, content: file.content })),
      { path: "manifest.json", content: manifestContent },
    ]);
    const manifestUpload = await this.core.uploadArtifact(command, `${asset.kind}-manifest.json`, manifestContent);
    const bundleUpload = await this.core.uploadArtifact(command, `${asset.kind}-bundle.zip`, bundle);
    return {
      kind: asset.kind,
      bundleArtifactKey: bundleUpload.artifactKey,
      manifestArtifactKey: manifestUpload.artifactKey,
      checksum: sha256(bundle),
      summary: {
        ...asset.summary,
        files: asset.files.length,
        bytes: asset.files.reduce((sum, file) => sum + file.content.length, 0),
      },
    };
  }
}

function validateAsset(asset: GeneratedKnowledgeAsset): void {
  if (!asset.title.trim()) throw new Error(`${asset.kind} asset title is empty`);
  if (asset.files.length > 5000) throw new Error(`${asset.kind} asset has too many files`);
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const file of asset.files) {
    if (!file.id || file.id.length > 200) throw new Error(`${asset.kind} contains an invalid file id`);
    if (!file.title || file.title.length > 300) throw new Error(`${asset.kind} contains an invalid file title`);
    if (!file.path || file.path.length > 1000 || file.path.startsWith("/") || file.path.includes("../")) {
      throw new Error(`${asset.kind} contains an unsafe file path ${file.path}`);
    }
    if (ids.has(file.id)) throw new Error(`${asset.kind} contains duplicate file id ${file.id}`);
    if (paths.has(file.path)) throw new Error(`${asset.kind} contains duplicate file path ${file.path}`);
    ids.add(file.id);
    paths.add(file.path);
  }
}

function artifactFileName(kind: string, file: KnowledgeFile): string {
  const extension = file.path.endsWith(".json") ? ".json" : ".md";
  return `${kind}-file-${sha256(Buffer.from(file.path)).slice(0, 20)}${extension}`;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
