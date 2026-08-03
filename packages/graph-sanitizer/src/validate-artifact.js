"use strict";

const path = require("node:path");
const { sensitiveString } = require("./secret-scanner");

class GraphArtifactValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "GraphArtifactValidationError";
    this.code = "sanitized_graph_invalid";
    this.status = 422;
  }
}

function validatePortablePath(value, field) {
  if (!value || typeof value !== "string") {
    throw new GraphArtifactValidationError(`${field} must be a relative path.`);
  }
  if (path.isAbsolute(value) || value.split("/").includes("..")) {
    throw new GraphArtifactValidationError(`${field} must stay repository-relative.`);
  }
}

function walk(value, field = "artifact") {
  if (typeof value === "string") {
    const reason = sensitiveString(value);
    if (reason) {
      throw new GraphArtifactValidationError(`${field} contains disallowed ${reason}.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${field}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => walk(item, `${field}.${key}`));
  }
}

function validateSanitizedGraphArtifact(artifact, { projectId, maxBytes = 5_000_000 } = {}) {
  if (!artifact || artifact.schemaVersion !== "1.0") {
    throw new GraphArtifactValidationError("Unsupported sanitized graph schema version.");
  }
  if (!artifact.project?.id || (projectId && artifact.project.id !== projectId)) {
    throw new GraphArtifactValidationError("Sanitized graph Project identity does not match.");
  }
  if (!Array.isArray(artifact.graph?.entities) || !Array.isArray(artifact.graph?.relations)) {
    throw new GraphArtifactValidationError("Sanitized graph must contain entity and relation arrays.");
  }
  if (Buffer.byteLength(JSON.stringify(artifact), "utf8") > maxBytes) {
    throw new GraphArtifactValidationError("Sanitized graph exceeds the upload size limit.");
  }

  const entityIds = new Set();
  for (const [index, entity] of artifact.graph.entities.entries()) {
    if (!entity.id || entityIds.has(entity.id)) {
      throw new GraphArtifactValidationError(`Entity ${index} has a missing or duplicate ID.`);
    }
    entityIds.add(entity.id);
    if (entity.path) validatePortablePath(entity.path, `entities[${index}].path`);
    for (const [evidenceIndex, evidence] of (entity.evidence || []).entries()) {
      validatePortablePath(evidence.file, `entities[${index}].evidence[${evidenceIndex}].file`);
      if (Object.hasOwn(evidence, "excerpt")) {
        throw new GraphArtifactValidationError("Sanitized evidence cannot contain source excerpts.");
      }
    }
  }
  for (const [index, relation] of artifact.graph.relations.entries()) {
    if (!entityIds.has(relation.source) || !entityIds.has(relation.target)) {
      throw new GraphArtifactValidationError(`Relation ${index} references an unknown entity.`);
    }
    for (const [evidenceIndex, evidence] of (relation.evidence || []).entries()) {
      validatePortablePath(evidence.file, `relations[${index}].evidence[${evidenceIndex}].file`);
      if (Object.hasOwn(evidence, "excerpt")) {
        throw new GraphArtifactValidationError("Sanitized evidence cannot contain source excerpts.");
      }
    }
  }
  walk(artifact);
  return artifact;
}

module.exports = { GraphArtifactValidationError, validateSanitizedGraphArtifact };
