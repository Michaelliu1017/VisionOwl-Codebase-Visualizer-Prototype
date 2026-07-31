"use strict";

const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const {
  adaptExecutionFlows,
  readArtifact,
} = require("./execution-flow-artifact");

function stableId(prefix, value) {
  return `${prefix}:${createHash("sha1").update(value).digest("hex").slice(0, 16)}`;
}

function gitValue(repoPath, args) {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    timeout: 3000,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function sourceEvidence(node) {
  if (!node?.filePath) return null;
  return {
    file: node.filePath,
    line: Array.isArray(node.lineRange) ? node.lineRange[0] : undefined,
    endLine: Array.isArray(node.lineRange) ? node.lineRange[1] : undefined,
    symbol: node.type === "file" ? undefined : node.name,
  };
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
}

function relationLabel(type) {
  const values = {
    calls: "调用",
    dispatches: "投放任务",
    imports: "导入",
    pops: "消费队列",
    pushes: "写入队列",
    reads: "读取",
    reports: "上报",
    writes: "写入",
  };
  return values[type] || String(type || "related").replaceAll("_", " ");
}

function repositoryDomain(repository) {
  if (!repository || repository === "." || repository === "__workspace__") {
    return undefined;
  }
  return String(repository).split("/").filter(Boolean).at(-1);
}

function infrastructureDomain(entity) {
  const explicit = String(entity?.layer || "").trim();
  if (explicit) return explicit;
  const prefix = String(entity?.name || "").split("·")[0].trim();
  return prefix || "Infrastructure";
}

function adaptArchitectureResources({
  execution,
  project,
  layerEntityByFilePath,
}) {
  const promotedIdByExecutionId = new Map();
  const resources = execution.entities
    .filter((entity) => entity.category === "data")
    .map((entity) => {
      const id = stableId(
        "architecture-resource",
        `${project.id}:${entity.metadata.artifactId || entity.id}`,
      );
      promotedIdByExecutionId.set(entity.id, id);
      return {
        ...entity,
        id,
        layer: "Infrastructure",
        tags: [
          "architecture-resource",
          ...(entity.tags || []).filter((tag) => tag !== "execution-flow"),
        ].slice(0, 10),
        metadata: {
          ...entity.metadata,
          execution: false,
          architectureResource: true,
          domain: infrastructureDomain(entity),
          resourceDomain: entity.layer,
          sourceExecutionEntityId: entity.id,
        },
      };
    });

  const executionEntityById = new Map(
    execution.entities.map((entity) => [entity.id, entity]),
  );
  const endpoint = (executionId) => {
    const promoted = promotedIdByExecutionId.get(executionId);
    if (promoted) return promoted;
    const entity = executionEntityById.get(executionId);
    const filePath = entity?.path || entity?.evidence?.[0]?.file;
    return filePath ? layerEntityByFilePath.get(filePath) : undefined;
  };

  const grouped = new Map();
  for (const relation of execution.relations) {
    const source = endpoint(relation.source);
    const target = endpoint(relation.target);
    const sourceEntity = executionEntityById.get(relation.source);
    const targetEntity = executionEntityById.get(relation.target);
    const touchesResource =
      promotedIdByExecutionId.has(relation.source) ||
      promotedIdByExecutionId.has(relation.target);
    const crossesExecutionDomain =
      sourceEntity?.layer &&
      targetEntity?.layer &&
      sourceEntity.layer !== targetEntity.layer;
    if (
      !source ||
      !target ||
      source === target ||
      (!touchesResource && !crossesExecutionDomain)
    ) {
      continue;
    }
    const key = `${source}|${target}|${relation.label || relation.type}`;
    const current = grouped.get(key) || {
      source,
      target,
      type: relation.type,
      label: relation.label || relationLabel(relation.type),
      touchesResource,
      evidence: [],
      relationIds: [],
    };
    current.touchesResource ||= touchesResource;
    current.relationIds.push(relation.id);
    current.evidence.push(...(relation.evidence || []));
    grouped.set(key, current);
  }

  const relations = [...grouped.entries()].map(([key, value]) => ({
    id: stableId("architecture-resource-relation", `${project.id}:${key}`),
    projectId: project.id,
    source: value.source,
    target: value.target,
    type: value.type,
    label: value.label,
    status: "healthy",
    directed: true,
    generated: true,
    metadata: {
      analyzer: "execution-flow-evidence",
      execution: false,
      architectureResource: value.touchesResource,
      architectureFlow: true,
      references: value.relationIds.length,
      sourceRelationIds: value.relationIds,
    },
    evidence: value.evidence.slice(0, 8),
  }));

  return { entities: resources, relations };
}

function adaptUnderstandGraph(
  knowledgeGraph,
  project,
  repoPath,
  executionArtifact = readArtifact(repoPath),
) {
  if (!Array.isArray(knowledgeGraph.layers) || knowledgeGraph.layers.length === 0) {
    throw new Error(
      "Understand-Anything graph has no architecture layers; refusing to invent module boundaries.",
    );
  }

  const uaNodes = Array.isArray(knowledgeGraph.nodes) ? knowledgeGraph.nodes : [];
  const uaEdges = Array.isArray(knowledgeGraph.edges) ? knowledgeGraph.edges : [];
  const nodeById = new Map(uaNodes.map((node) => [node.id, node]));
  const entityIdByLayer = new Map();
  const layerByNode = new Map();
  const repositoryByLayer = new Map();

  for (const layer of knowledgeGraph.layers) {
    const entityId = stableId("ua-layer", `${project.id}:${layer.id}`);
    entityIdByLayer.set(layer.id, entityId);
    repositoryByLayer.set(layer.id, repositoryDomain(layer.repository));
    for (const nodeId of layer.nodeIds || []) layerByNode.set(nodeId, layer.id);
  }

  for (const node of uaNodes) {
    if (layerByNode.has(node.id) || !node.filePath) continue;
    const fileId = `file:${node.filePath}`;
    const owner = layerByNode.get(fileId);
    if (owner) layerByNode.set(node.id, owner);
  }

  const entities = [];
  const layerEntityByFilePath = new Map();

  for (const layer of knowledgeGraph.layers) {
    const members = (layer.nodeIds || [])
      .map((nodeId) => nodeById.get(nodeId))
      .filter(Boolean);
    const tags = [
      ...new Set(members.flatMap((node) => node.tags || [])),
    ].slice(0, 10);
    const entityId = entityIdByLayer.get(layer.id);
    for (const member of members) {
      if (member.filePath && !layerEntityByFilePath.has(member.filePath)) {
        layerEntityByFilePath.set(member.filePath, entityId);
      }
    }
    entities.push({
      id: entityId,
      projectId: project.id,
      category: "code",
      kind: "module",
      name: layer.name,
      summary: layer.description,
      status: "healthy",
      path: `architecture/${String(layer.id).replace(/^layer:/, "")}`,
      layer: layer.name,
      tags: tags.length > 0 ? tags : ["architecture-layer"],
      metadata: {
        analyzer: "understand-anything",
        uaLayerId: layer.id,
        repository: layer.repository,
        domain: repositoryDomain(layer.repository),
        memberCount: members.length,
        members: members.slice(0, 100).map((node) => ({
          id: node.id,
          type: node.type,
          name: node.name,
          filePath: node.filePath,
          summary: node.summary,
        })),
      },
      evidence: members.map(sourceEvidence).filter(Boolean).slice(0, 8),
    });
  }

  const relations = [];

  const aggregated = new Map();
  for (const edge of uaEdges) {
    const sourceLayer = layerByNode.get(edge.source);
    const targetLayer = layerByNode.get(edge.target);
    if (!sourceLayer || !targetLayer || sourceLayer === targetLayer) continue;
    const sourceRepository = repositoryByLayer.get(sourceLayer);
    const targetRepository = repositoryByLayer.get(targetLayer);
    if (
      sourceRepository &&
      targetRepository &&
      sourceRepository !== targetRepository
    ) {
      continue;
    }
    const source = entityIdByLayer.get(sourceLayer);
    const target = entityIdByLayer.get(targetLayer);
    const key = `${source}|${target}`;
    const current = aggregated.get(key) || {
      source,
      target,
      types: [],
      weights: [],
      evidence: [],
    };
    current.types.push(edge.type || "related");
    if (Number.isFinite(edge.weight)) current.weights.push(edge.weight);
    const evidence = sourceEvidence(nodeById.get(edge.source));
    if (evidence && current.evidence.length < 8) current.evidence.push(evidence);
    aggregated.set(key, current);
  }

  for (const [key, value] of aggregated) {
    const primaryType = mostCommon(value.types) || "related";
    relations.push({
      id: stableId("relation", `${project.id}:${key}`),
      projectId: project.id,
      source: value.source,
      target: value.target,
      type: primaryType,
      label: relationLabel(primaryType),
      status: "healthy",
      directed: true,
      generated: true,
      metadata: {
        analyzer: "understand-anything",
        references: value.types.length,
        edgeTypes: [...new Set(value.types)],
        averageWeight:
          value.weights.length > 0
            ? value.weights.reduce((sum, weight) => sum + weight, 0) /
              value.weights.length
            : undefined,
      },
      evidence: value.evidence,
    });
  }

  const execution = adaptExecutionFlows(
    executionArtifact,
    project,
    repoPath,
  );
  const architectureResources = adaptArchitectureResources({
    execution,
    project,
    layerEntityByFilePath,
  });

  return {
    source: "understand-anything",
    branch: gitValue(repoPath, ["branch", "--show-current"]) || undefined,
    commit:
      knowledgeGraph.project?.gitCommitHash?.slice(0, 12) ||
      gitValue(repoPath, ["rev-parse", "--short=12", "HEAD"]) ||
      undefined,
    entities: [
      ...entities,
      ...architectureResources.entities,
      ...execution.entities,
    ],
    relations: [
      ...relations,
      ...architectureResources.relations,
      ...execution.relations,
    ],
    executionFlows: execution.executionFlows,
  };
}

module.exports = {
  adaptUnderstandGraph,
};
