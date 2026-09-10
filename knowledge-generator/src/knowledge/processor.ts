import type { KnowledgeRunCommand } from "../codegraph/types.js";
import { validateCodeGraph } from "../codegraph/types.js";
import type { CoreIntegrationPort, PublishedAsset } from "../core/types.js";
import { KnowledgeAuditStore } from "./auditStore.js";
import type { EvidenceProviderPort } from "./evidenceProvider.js";
import { generateKnowledgeAssets } from "./generator.js";
import { buildModuleEvidenceBundles, linkEvidenceToCodeGraph } from "./linker.js";
import { KnowledgePublisher } from "./publisher.js";
import type { SemanticAnalyzerPort } from "./semantic.js";
import type { KnowledgeContext } from "./types.js";

export interface KnowledgeRunResult {
  runId: string;
  status: "succeeded" | "failed";
  artifacts?: PublishedAsset[];
  error?: string;
}

export interface KnowledgeRunProcessorOptions {
  core: CoreIntegrationPort;
  evidence: EvidenceProviderPort;
  semantic: SemanticAnalyzerPort;
  audit: KnowledgeAuditStore;
}

export class KnowledgeRunProcessor {
  private readonly publisher: KnowledgePublisher;

  constructor(private readonly options: KnowledgeRunProcessorOptions) {
    this.publisher = new KnowledgePublisher(options.core);
  }

  async process(runId: string): Promise<KnowledgeRunResult> {
    let command: KnowledgeRunCommand | undefined;
    try {
      command = await this.options.core.getCommand(runId);
      await this.progress(command, 3, "command", "已获取冻结任务命令");
      const graph = validateCodeGraph(await this.options.core.getGraph(command), command);
      await this.progress(command, 10, "graph", `已读取图谱：${graph.nodes.length} 节点 / ${graph.edges.length} 关系`);

      const repositories = await this.options.evidence.collect(command);
      await this.progress(command, 48, "evidence", `已采集 ${repositories.length} 个冻结仓库的工程证据`);

      const linked = linkEvidenceToCodeGraph(command, graph, repositories);
      const modules = buildModuleEvidenceBundles(graph, repositories, linked);
      await this.progress(
        command,
        58,
        "linking",
        `已将 ${linked.stats.linkedEvidence} 条证据关联到 ${modules.length} 个代码模块`,
      );

      const semantic = await this.options.semantic.analyze(graph, modules);
      await this.progress(command, 72, "semantic", `语义知识提炼完成（${semantic.provider}）`);

      const context: KnowledgeContext = { graph, repositories, linked, modules, semantic };
      await this.options.audit.writeContext(command, context);
      const assets = generateKnowledgeAssets(context, command.requestedAssets);
      await this.progress(command, 82, "render", `已生成 ${assets.length} 类知识资产`);

      await this.options.core.updateProgress(command, {
        status: "publishing",
        progress: 88,
        stage: "publishing",
        note: "正在上传 Wiki、Skills、Manifest 与证据追溯产物",
      });
      const published = await this.publisher.publish(command, assets);
      await this.options.audit.writePublished(runId, published);
      await this.options.core.complete(command, published);
      return { runId, status: "succeeded", artifacts: published };
    } catch (error) {
      const message = errorMessage(error);
      await this.options.audit.writeFailure(runId, message).catch(() => undefined);
      try {
        await this.options.core.fail(runId, message);
      } catch (callbackError) {
        throw new Error(`${message}; fail callback also failed: ${errorMessage(callbackError)}`, { cause: error });
      }
      return { runId, status: "failed", error: message };
    }
  }

  private async progress(command: KnowledgeRunCommand, progress: number, stage: string, note: string): Promise<void> {
    await this.options.core.updateProgress(command, { status: "running", progress, stage, note });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
