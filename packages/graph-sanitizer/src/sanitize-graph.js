"use strict";

const { normalizeRepositoryPath } = require("./path-normalizer");
const { sensitiveKey, sensitiveString } = require("./secret-scanner");

class SensitiveGraphDataError extends Error {
  constructor(message) {
    super(message);
    this.name = "SensitiveGraphDataError";
    this.code = "sanitized_graph_sensitive_data";
    this.status = 422;
  }
}

function safeText(value, field, maxLength = 1200) {
  const text = String(value ?? "").slice(0, maxLength);
  const reason = sensitiveString(text);
  if (reason) {
    throw new SensitiveGraphDataError(
      `Graph field "${field}" contains disallowed ${reason}.`,
    );
  }
  return text;
}

function sanitizeMetadata(value, field = "metadata", depth = 0) {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    if (sensitiveString(value)) return undefined;
    return value.slice(0, 500);
  }
  if (depth >= 4) return undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, 50)
      .map((item, index) => sanitizeMetadata(item, `${field}[${index}]`, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value === "object" && value) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 50)
        .filter(([key]) => !sensitiveKey(key))
        .map(([key, item]) => [key, sanitizeMetadata(item, `${field}.${key}`, depth + 1)])
        .filter(([, item]) => item !== undefined),
    );
  }
  return undefined;
}

function sanitizeEvidence(evidence, repositoryRoot) {
  return (Array.isArray(evidence) ? evidence : [])
    .filter((item) => item?.file)
    .slice(0, 30)
    .map((item) => ({
      file: normalizeRepositoryPath(item.file, repositoryRoot),
      ...(Number.isInteger(item.line) && item.line > 0 ? { line: item.line } : {}),
      ...(Number.isInteger(item.endLine) && item.endLine > 0
        ? { endLine: item.endLine }
        : {}),
      ...(item.symbol
        ? { symbol: safeText(item.symbol, "evidence.symbol", 240) }
        : {}),
    }));
}

function sanitizeGraphArtifact({ project, graph, repositoryRoot }) {
  const entities = (graph.entities || []).map((entity) => ({
    id: safeText(entity.id, "entity.id", 240),
    category: safeText(entity.category, "entity.category", 40),
    kind: safeText(entity.kind, "entity.kind", 80),
    name: safeText(entity.name, "entity.name", 240),
    summary: safeText(entity.summary, "entity.summary"),
    status: safeText(entity.status, "entity.status", 40),
    ...(entity.path
      ? { path: normalizeRepositoryPath(entity.path, repositoryRoot) }
      : {}),
    ...(entity.language
      ? { language: safeText(entity.language, "entity.language", 80) }
      : {}),
    ...(entity.layer ? { layer: safeText(entity.layer, "entity.layer", 120) } : {}),
    tags: (entity.tags || []).slice(0, 30).map((tag) => safeText(tag, "entity.tag", 120)),
    metadata: sanitizeMetadata(entity.metadata || {}) || {},
    evidence: sanitizeEvidence(entity.evidence, repositoryRoot),
    ...(entity.position && Number.isFinite(entity.position.x) && Number.isFinite(entity.position.y)
      ? { position: { x: entity.position.x, y: entity.position.y } }
      : {}),
  }));
  const relations = (graph.relations || []).map((relation) => ({
    id: safeText(relation.id, "relation.id", 240),
    source: safeText(relation.source, "relation.source", 240),
    target: safeText(relation.target, "relation.target", 240),
    type: safeText(relation.type, "relation.type", 100),
    label: safeText(relation.label, "relation.label", 240),
    status: safeText(relation.status, "relation.status", 40),
    directed: relation.directed === true,
    generated: relation.generated === true,
    metadata: sanitizeMetadata(relation.metadata || {}) || {},
    evidence: sanitizeEvidence(relation.evidence, repositoryRoot),
  }));

  return {
    schemaVersion: "1.0",
    project: {
      id: safeText(project.id, "project.id", 240),
      name: safeText(project.name, "project.name", 240),
    },
    source: {
      branch: safeText(graph.branch || project.branch || "master", "source.branch", 240),
      commit: safeText(graph.commit || project.commit || "", "source.commit", 120),
      generatedAt: new Date().toISOString(),
    },
    graph: {
      entities,
      relations,
      executionFlows: (graph.executionFlows || []).slice(0, 100).map((flow) => ({
        id: safeText(flow.id, "flow.id", 240),
        name: safeText(flow.name, "flow.name", 240),
        summary: safeText(flow.summary, "flow.summary"),
        entryPoint: safeText(flow.entryPoint, "flow.entryPoint", 240),
        featured: flow.featured === true,
        entityIds: (flow.entityIds || []).slice(0, 500).map(String),
        relationIds: (flow.relationIds || []).slice(0, 1000).map(String),
        lanes: (flow.lanes || []).slice(0, 100).map((lane) => safeText(lane, "flow.lane", 120)),
      })),
    },
  };
}

module.exports = {
  SensitiveGraphDataError,
  sanitizeGraphArtifact,
  sanitizeMetadata,
};
