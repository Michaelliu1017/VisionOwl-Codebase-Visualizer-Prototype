import type { FastifyPluginAsync } from "fastify";
import {
  annIdParam,
  annotationQuery,
  createAnnotationBody,
  parseOrThrow,
  patchAnnotationBody,
  projectIdParam,
} from "../schemas/requests";
import {
  createAnnotation,
  deleteAnnotation,
  listAnnotations,
  patchAnnotation,
} from "../services/annotations";
import { clientIp, requireProjectRole } from "./hooks";

/** 契约 §4.8 批注 */
export const annotationRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/projects/:id/annotations", async (req) => {
    const { id } = parseOrThrow(projectIdParam, req.params);
    await requireProjectRole(req, id, "editor");
    const q = parseOrThrow(annotationQuery, req.query ?? {});
    return { items: await listAnnotations(id, q) };
  });

  app.post("/api/projects/:id/annotations", async (req, reply) => {
    const { id } = parseOrThrow(projectIdParam, req.params);
    const membership = await requireProjectRole(req, id, "editor");
    const body = parseOrThrow(createAnnotationBody, req.body);
    const ann = await createAnnotation(id, membership.userId, body, clientIp(req));
    return reply.code(201).send(ann);
  });

  app.patch("/api/projects/:id/annotations/:annId", async (req) => {
    const { id, annId } = parseOrThrow(annIdParam, req.params);
    const membership = await requireProjectRole(req, id, "editor");
    const patch = parseOrThrow(patchAnnotationBody, req.body);
    return patchAnnotation(
      id,
      annId,
      { id: membership.userId, role: membership.role },
      patch,
      clientIp(req),
    );
  });

  app.delete("/api/projects/:id/annotations/:annId", async (req, reply) => {
    const { id, annId } = parseOrThrow(annIdParam, req.params);
    const membership = await requireProjectRole(req, id, "editor");
    await deleteAnnotation(id, annId, { id: membership.userId, role: membership.role }, clientIp(req));
    return reply.code(204).send();
  });
};
