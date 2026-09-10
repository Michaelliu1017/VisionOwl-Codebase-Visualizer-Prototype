import { createHash } from "node:crypto";
import type { KnowledgeRunCommand } from "../codegraph/types.js";
import type {
  CoreIntegrationPort,
  ProgressUpdate,
  PublishedAsset,
  UploadedArtifact,
} from "./types.js";

export interface CoreClientOptions {
  baseUrl: string;
  serviceToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class CoreClient implements CoreIntegrationPort {
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: CoreClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.serviceToken = options.serviceToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async getCommand(runId: string): Promise<KnowledgeRunCommand> {
    const command = await this.requestJson<KnowledgeRunCommand>(
      `/internal/v1/knowledge-runs/${encodeURIComponent(runId)}/command`,
    );
    validateCommand(command, runId);
    return command;
  }

  async getGraph(command: KnowledgeRunCommand): Promise<unknown> {
    return this.requestJson(command.graphDownloadPath);
  }

  async updateProgress(command: KnowledgeRunCommand, update: ProgressUpdate): Promise<void> {
    await this.requestJson(command.callbacks.progress, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    });
  }

  async uploadArtifact(
    command: KnowledgeRunCommand,
    fileName: string,
    content: Buffer,
  ): Promise<UploadedArtifact> {
    const path = command.artifactUploadPath.replace("{fileName}", encodeURIComponent(fileName));
    return this.requestJson<UploadedArtifact>(path, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "x-content-sha256": sha256(content),
      },
      body: Uint8Array.from(content),
    });
  }

  async complete(command: KnowledgeRunCommand, artifacts: PublishedAsset[]): Promise<void> {
    await this.requestJson(command.callbacks.complete, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ artifacts }),
    });
  }

  async fail(runId: string, error: string): Promise<void> {
    await this.requestJson(`/internal/v1/knowledge-runs/${encodeURIComponent(runId)}/fail`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: error.slice(0, 2000) }),
    });
  }

  private async requestJson<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${normalizedPath(path)}`, {
        ...init,
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "x-visionowl-service-token": this.serviceToken,
          ...init.headers,
        },
      });
      const body = await response.arrayBuffer();
      if (!response.ok) {
        const text = Buffer.from(body).toString("utf8").slice(0, 2000);
        throw new Error(`VisionOwl Core ${response.status} ${path}: ${text || response.statusText}`);
      }
      if (body.byteLength === 0) return undefined as T;
      const text = Buffer.from(body).toString("utf8");
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(`VisionOwl Core returned non-JSON for ${path}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

function validateCommand(command: KnowledgeRunCommand, expectedRunId: string): void {
  if (!command || command.schemaVersion !== "1.0") throw new Error("unsupported knowledge command");
  if (command.runId !== expectedRunId) throw new Error("knowledge command runId mismatch");
  if (!command.projectId || !command.graphVersionId || !command.graphDownloadPath) {
    throw new Error("knowledge command is incomplete");
  }
  if (!Array.isArray(command.repositorySnapshots) || command.repositorySnapshots.length === 0) {
    throw new Error("knowledge command contains no repository snapshots");
  }
  if (!Array.isArray(command.requestedAssets) || command.requestedAssets.length === 0) {
    throw new Error("knowledge command contains no requested assets");
  }
  const deadline = Date.parse(command.deadlineAt);
  if (!Number.isFinite(deadline)) throw new Error("knowledge command has an invalid deadline");
}

function normalizedPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
