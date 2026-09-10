import type { FastifyPluginAsync } from "fastify";
import { createProjectBody, parseOrThrow, patchProjectBody, projectIdParam } from "../schemas/requests";
import { audit } from "../services/audit";
import { createProject, deleteProject, getProject, listMyProjects, patchProject } from "../services/projects";
import { clientIp, currentUserId, requireProjectRole } from "./hooks";

/** 契约 §4.2 Project */
export const projectRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/projects", async (req) => ({ items: await listMyProjects(currentUserId(req)) }));

  app.post("/api/projects", async (req, reply) => {
    const body = parseOrThrow(createProjectBody, req.body);
    const project = await createProject(currentUserId(req), body.name);
    await audit({
      projectId: project.id,
      actorId: currentUserId(req),
      action: "project.created",
      targetType: "project",
      targetId: project.id,
      detail: { name: project.name },
      ip: clientIp(req),
    });
    return reply.code(201).send(project);
  });

  app.get("/api/projects/:id", async (req) => {
    const { id } = parseOrThrow(projectIdParam, req.params);
    const membership = await requireProjectRole(req, id, "editor");
    return getProject(id, membership);
  });

  app.patch("/api/projects/:id", async (req) => {
    const { id } = parseOrThrow(projectIdParam, req.params);
    const membership = await requireProjectRole(req, id, "editor");
    const patch = parseOrThrow(patchProjectBody, req.body);
    const project = await patchProject(id, membership, patch);
    await audit({
      projectId: id,
      actorId: membership.userId,
      action: "project.updated",
      targetType: "project",
      targetId: id,
      detail: patch,
      ip: clientIp(req),
    });
    return project;
  });

  app.delete("/api/projects/:id", async (req, reply) => {
    const { id } = parseOrThrow(projectIdParam, req.params);
    const membership = await requireProjectRole(req, id, "owner");
    await deleteProject(id);
    await audit({
      projectId: id,
      actorId: membership.userId,
      action: "project.deleted",
      targetType: "project",
      targetId: id,
      ip: clientIp(req),
    });
    return reply.code(204).send();
  });
};
