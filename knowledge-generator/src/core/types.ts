import type { KnowledgeRunCommand } from "../codegraph/types.js";

export interface ProgressUpdate {
  status: "running" | "publishing";
  progress: number;
  stage?: string;
  note?: string;
}

export interface UploadedArtifact {
  artifactKey: string;
  checksum: string;
  size: number;
}

export interface AssetManifestEntry {
  id: string;
  title: string;
  path: string;
  artifactKey: string;
  mediaType: string;
  size: number;
  sha256: string;
}

export interface AssetManifest {
  schemaVersion: "1.0";
  kind: "wiki" | "skills";
  title: string;
  files: AssetManifestEntry[];
}

export interface PublishedAsset {
  kind: "wiki" | "skills";
  bundleArtifactKey: string;
  manifestArtifactKey: string;
  checksum: string;
  summary: Record<string, unknown>;
}

export interface CoreIntegrationPort {
  getCommand(runId: string): Promise<KnowledgeRunCommand>;
  getGraph(command: KnowledgeRunCommand): Promise<unknown>;
  updateProgress(command: KnowledgeRunCommand, update: ProgressUpdate): Promise<void>;
  uploadArtifact(command: KnowledgeRunCommand, fileName: string, content: Buffer): Promise<UploadedArtifact>;
  complete(command: KnowledgeRunCommand, artifacts: PublishedAsset[]): Promise<void>;
  fail(runId: string, error: string): Promise<void>;
}
