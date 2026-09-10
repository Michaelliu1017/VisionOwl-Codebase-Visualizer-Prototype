import Fastify, { type FastifyInstance } from "fastify";
import type { SyncRequestOptions } from "../domain/types.js";
import { buildSnapshot } from "../evidence/snapshot.js";
import type { EvidenceStore } from "../storage/store.js";
import type { SyncOrchestrator } from "../sync/orchestrator.js";

export interface CreateAppOptions {
  store: EvidenceStore;
  orchestrator: SyncOrchestrator;
  logger?: boolean;
}

export function createApp(options: CreateAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async () => ({ status: "ready" }));

  app.get("/v1/sources", async () => ({ items: await options.store.listSources() }));

  app.get<{ Params: { sourceId: string } }>("/v1/sources/:sourceId", async (request, reply) => {
    const source = await options.store.getSource(request.params.sourceId);
    if (!source) return reply.code(404).send({ error: "source_not_found" });
    return source;
  });

  app.post<{
    Body: { projectId?: string; repoUrl?: string; branch?: string; historySince?: string };
  }>("/v1/sources", async (request, reply) => {
    const { projectId, repoUrl, branch, historySince } = request.body ?? {};
    if (!projectId || !repoUrl) {
      return reply.code(400).send({ error: "projectId_and_repoUrl_are_required" });
    }
    const source = await options.orchestrator.registerSource({ projectId, repoUrl, branch, historySince });
    return reply.code(201).send(source);
  });

  app.post<{
    Params: { sourceId: string };
    Body: SyncRequestOptions;
  }>("/v1/sources/:sourceId/sync", async (request, reply) => {
    const source = await options.store.getSource(request.params.sourceId);
    if (!source) return reply.code(404).send({ error: "source_not_found" });
    const run = await options.orchestrator.startSync(source.id, request.body ?? {});
    return reply.code(202).send(run);
  });

  app.get<{ Params: { runId: string } }>("/v1/sync-runs/:runId", async (request, reply) => {
    const run = await options.store.getSyncRun(request.params.runId);
    if (!run) return reply.code(404).send({ error: "sync_run_not_found" });
    return run;
  });

  app.get<{
    Params: { repositoryId: string };
    Querystring: { kind?: string; limit?: string };
  }>("/v1/repositories/:repositoryId/evidence", async (request) => {
    const repositoryId = decodeURIComponent(request.params.repositoryId);
    const limit = Math.min(Math.max(Number(request.query.limit ?? 200), 1), 1_000);
    const nodes = await options.store.listNodes(repositoryId);
    const filtered = request.query.kind ? nodes.filter((node) => node.kind === request.query.kind) : nodes;
    return { items: filtered.slice(0, limit), total: filtered.length };
  });

  app.get<{ Params: { repositoryId: string } }>(
    "/v1/repositories/:repositoryId/evidence-graph",
    async (request, reply) => {
      const repositoryId = decodeURIComponent(request.params.repositoryId);
      const source = (await options.store.listSources()).find((candidate) => candidate.repositoryId === repositoryId);
      if (!source) return reply.code(404).send({ error: "repository_not_found" });
      return buildSnapshot(options.store, source);
    },
  );

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    const status = typeof error.statusCode === "number" && error.statusCode >= 400 ? error.statusCode : 500;
    reply.code(status).send({ error: status === 500 ? "internal_error" : error.name, message: error.message });
  });

  return app;
}
