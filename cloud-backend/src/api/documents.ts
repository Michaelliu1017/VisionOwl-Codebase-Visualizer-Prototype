import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readArtifact } from "../infra/artifacts";
import { enqueueDocgen, getDocgenState, setDocgenState } from "../infra/redis";
import { badRequest, notFound } from "../lib/errors";
import {
  createDocumentBody,
  docIdParam,
  documentQuery,
  parseOrThrow,
  patchDocumentBody,
  projectIdParam,
} from "../schemas/requests";
import {
  createDocument,
  deleteDocument,
  findGeneratedDocumentTarget,
  getDocument,
  listDocuments,
  listRevisions,
  patchDocument,
  upsertGeneratedDoc,
} from "../services/documents";
import { getCurrentGraphDocument, getCurrentVersion } from "../services/graph";
import { clientIp, requireProjectRole } from "./hooks";

const generateBody = z.object({
  nodeId: z.string().trim().regex(/^module:[\w./-]+$/, "仅支持 module: 节点"),
});

const publishBody = z.object({
  profileKey: z.string().trim().min(1).max(500),
  dingtalkNodeId: z.string().trim().min(1).max(1000),
  url: z.string().url().refine((value) => {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "dingtalk.com" || hostname.endsWith(".dingtalk.com");
  }, "仅支持钉钉文档地址"),
});

/** 契约 §4.7 文档 */
export const documentRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/projects/:id/documents", async (req) => {
    const { id } = parseOrThrow(projectIdParam, req.params);
    await requireProjectRole(req, id, "editor");
    const q = parseOrThrow(documentQuery, req.query ?? {});
    return { items: await listDocuments(id, q) };
  });

  app.post("/api/projects/:id/documents", async (req, reply) => {
    const { id } = parseOrThrow(projectIdParam, req.params);
    const membership = await requireProjectRole(req, id, "editor");
    const body = parseOrThrow(createDocumentBody, req.body);
    const doc = await createDocument(id, membership.userId, body, clientIp(req));
    return reply.code(201).send(doc);
  });

  app.patch("/api/projects/:id/documents/:docId", async (req) => {
    const { id, docId } = parseOrThrow(docIdParam, req.params);
    const membership = await requireProjectRole(req, id, "editor");
    const patch = parseOrThrow(patchDocumentBody, req.body);
    return patchDocument(id, docId, membership.userId, patch, clientIp(req));
  });

  app.delete("/api/projects/:id/documents/:docId", async (req, reply) => {
    const { id, docId } = parseOrThrow(docIdParam, req.params);
    const membership = await requireProjectRole(req, id, "editor");
    await deleteDocument(id, docId, membership.userId, clientIp(req));
    return reply.code(204).send();
  });

  app.get("/api/projects/:id/documents/:docId/revisions", async (req) => {
    const { id, docId } = parseOrThrow(docIdParam, req.params);
    await requireProjectRole(req, id, "editor");
    return { items: await listRevisions(id, docId) };
  });

  app.post("/api/projects/:id/documents/generate", async (req, reply) => {
    const { id } = parseOrThrow(projectIdParam, req.params);
    const membership = await requireProjectRole(req, id, "editor");
    const { nodeId } = parseOrThrow(generateBody, req.body);
    const current = await getCurrentVersion(id).catch(() => null);
    if (!current) throw badRequest("项目尚无图谱，无法生成模块文档");
    const graph = await getCurrentGraphDocument(id);
    const node = graph?.nodes.find((item) => item.id === nodeId && item.kind === "module");
    if (!node) throw badRequest("当前图谱中不存在该模块");
    const repositoryCommits = graph?.repositoryCommits ?? {};
    const nodePath = node.path?.trim();
    if (!nodePath) throw badRequest("该模块缺少源码路径，无法生成文档");
    const existing = await findGeneratedDocumentTarget(id, nodeId);

    const taskId = randomUUID();
    await setDocgenState(taskId, {
      status: "pending",
      projectId: id,
      nodeId,
      nodePath,
      actorId: membership.userId,
      commitSha: node.repositoryId
        ? repositoryCommits[node.repositoryId] ?? current.commitSha
        : current.commitSha,
      repositoryId: node.repositoryId,
      existingDingtalkNodeId: existing?.dingtalkNodeId ?? "",
    });
    await enqueueDocgen(taskId, id);
    return reply.code(202).send({
      taskId,
      nodeId,
      commitSha: node.repositoryId
        ? repositoryCommits[node.repositoryId] ?? current.commitSha
        : current.commitSha,
    });
  });

  app.get("/api/projects/:id/docgen/:taskId", async (req) => {
    const params = parseOrThrow(
      projectIdParam.extend({ taskId: z.string().uuid() }),
      req.params,
    );
    await requireProjectRole(req, params.id, "editor");
    const state = await getDocgenState(params.taskId);
    if (!state || state.projectId !== params.id) throw notFound("生成任务不存在或已过期");
    return {
      taskId: params.taskId,
      status: state.status,
      nodeId: state.nodeId,
      commitSha: state.commitSha,
      docId: state.docId ?? null,
      error: state.error ?? null,
      credits: state.credits ? Number(state.credits) : null,
    };
  });

  app.get("/api/projects/:id/docgen/:taskId/publication", async (req) => {
    const params = parseOrThrow(
      projectIdParam.extend({ taskId: z.string().uuid() }),
      req.params,
    );
    await requireProjectRole(req, params.id, "editor");
    const state = await getDocgenState(params.taskId);
    if (!state || state.projectId !== params.id) throw notFound("生成任务不存在或已过期");
    if (state.status !== "ready_to_publish" || !state.artifactKey || !state.title) {
      throw badRequest("文档内容尚未准备好");
    }
    const markdown = (await readArtifact(state.artifactKey)).toString("utf8");
    return {
      taskId: params.taskId,
      nodeId: state.nodeId,
      title: state.title,
      markdown,
      existingDingtalkNodeId: state.existingDingtalkNodeId || null,
    };
  });

  app.post("/api/projects/:id/docgen/:taskId/published", async (req) => {
    const params = parseOrThrow(
      projectIdParam.extend({ taskId: z.string().uuid() }),
      req.params,
    );
    const membership = await requireProjectRole(req, params.id, "editor");
    const body = parseOrThrow(publishBody, req.body);
    const state = await getDocgenState(params.taskId);
    if (!state || state.projectId !== params.id) throw notFound("生成任务不存在或已过期");
    if (state.status === "succeeded" && state.docId) return getDocument(params.id, state.docId);
    if (state.status !== "ready_to_publish" || !state.artifactKey || !state.title) {
      throw badRequest("文档任务当前不可确认发布");
    }
    const document = await upsertGeneratedDoc(
      params.id,
      {
        scope: "module",
        nodeId: state.nodeId,
        title: state.title,
        url: body.url,
        docType: "dingtalk",
        artifactKey: state.artifactKey,
        dingtalkConnectionId: null,
        dingtalkNodeId: body.dingtalkNodeId,
      },
      membership.userId,
    );
    await setDocgenState(params.taskId, { status: "succeeded", docId: document.id });
    req.log.info(
      { projectId: params.id, taskId: params.taskId, profileKey: body.profileKey },
      "desktop DWS publication confirmed",
    );
    return document;
  });

  app.get("/api/projects/:id/documents/:docId/content", async (req) => {
    const { id, docId } = parseOrThrow(docIdParam, req.params);
    await requireProjectRole(req, id, "editor");
    const doc = await getDocument(id, docId);
    const target = await findGeneratedDocumentTarget(id, doc.nodeId);
    const prefix = "visionowl://artifact/";
    const key = target?.artifactKey ?? (doc.url.startsWith(prefix) ? doc.url.slice(prefix.length) : "");
    if (!key) throw badRequest("该文档没有可读取的平台快照");
    if (!key.startsWith(`${id}/`) && !key.startsWith(`visionowl/${id}/`)) {
      throw notFound("文档产物不属于该项目");
    }
    const markdown = (await readArtifact(key)).toString("utf8");
    return { docId, title: doc.title, updatedAt: doc.updatedAt, markdown };
  });
};
