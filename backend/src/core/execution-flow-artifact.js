"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

function stableId(prefix, value) {
  return `${prefix}:${createHash("sha1").update(value).digest("hex").slice(0, 16)}`;
}

function dataDirectory(repoPath) {
  const legacy = path.join(repoPath, ".understand-anything");
  return fs.existsSync(legacy) ? legacy : path.join(repoPath, ".ua");
}

function artifactPath(repoPath) {
  return path.join(dataDirectory(repoPath), "execution-flows.json");
}

function readArtifact(repoPath) {
  const filePath = artifactPath(repoPath);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse ${filePath}: ${error.message}`);
  }
}

function normalizeEvidence(repoPath, evidence, owner) {
  const values = Array.isArray(evidence) ? evidence : [];
  return values.map((item) => {
    if (!item || typeof item.file !== "string" || !item.file.trim()) {
      throw new Error(`${owner} has evidence without a source file.`);
    }
    const file = item.file.replaceAll("\\", "/").replace(/^\.\/+/, "");
    const resolved = path.resolve(repoPath, file);
    const relative = path.relative(repoPath, resolved);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      !fs.existsSync(resolved)
    ) {
      throw new Error(`${owner} references a missing source file: ${file}`);
    }
    return {
      file,
      line:
        Number.isInteger(item.line) && item.line > 0 ? item.line : undefined,
      endLine:
        Number.isInteger(item.endLine) && item.endLine > 0
          ? item.endLine
          : undefined,
      symbol:
        typeof item.symbol === "string" && item.symbol.trim()
          ? item.symbol.trim()
          : undefined,
      excerpt:
        typeof item.excerpt === "string" && item.excerpt.trim()
          ? item.excerpt.trim()
          : undefined,
    };
  });
}

function validateArtifact(repoPath, artifact) {
  if (!artifact) return null;
  if (!Array.isArray(artifact.components) || !Array.isArray(artifact.flows)) {
    throw new Error(
      "execution-flows.json must contain components and flows arrays.",
    );
  }

  const componentIds = new Set();
  const components = artifact.components.map((component) => {
    if (!component?.id || componentIds.has(component.id)) {
      throw new Error(
        `execution-flows.json has a missing or duplicate component id: ${component?.id}`,
      );
    }
    componentIds.add(component.id);
    const category = ["code", "runtime", "data", "external"].includes(
      component.category,
    )
      ? component.category
      : "code";
    return {
      ...component,
      category,
      kind: component.kind || (category === "code" ? "module" : "resource"),
      domain: component.domain || "Project",
      evidence: normalizeEvidence(
        repoPath,
        component.evidence,
        `component ${component.id}`,
      ),
    };
  });

  const flowIds = new Set();
  const flows = artifact.flows.map((flow) => {
    if (!flow?.id || flowIds.has(flow.id)) {
      throw new Error(
        `execution-flows.json has a missing or duplicate flow id: ${flow?.id}`,
      );
    }
    flowIds.add(flow.id);
    const steps = Array.isArray(flow.steps) ? flow.steps : [];
    if (steps.length < 2) {
      throw new Error(`flow ${flow.id} must contain at least two steps.`);
    }
    for (const componentId of steps) {
      if (!componentIds.has(componentId)) {
        throw new Error(
          `flow ${flow.id} references unknown component ${componentId}.`,
        );
      }
    }
    const transitions = (flow.transitions || []).map((transition, index) => {
      if (
        !componentIds.has(transition.source) ||
        !componentIds.has(transition.target)
      ) {
        throw new Error(
          `flow ${flow.id} transition ${index + 1} has an unknown endpoint.`,
        );
      }
      return {
        ...transition,
        label: transition.label || transition.type || "调用",
        type: transition.type || "calls",
        evidence: normalizeEvidence(
          repoPath,
          transition.evidence,
          `flow ${flow.id} transition ${index + 1}`,
        ),
      };
    });
    if (transitions.length === 0) {
      throw new Error(`flow ${flow.id} must contain transitions.`);
    }
    return {
      ...flow,
      lanes: Array.isArray(flow.lanes) ? flow.lanes : [],
      steps,
      transitions,
    };
  });

  return {
    version: artifact.version || "1.0.0",
    projectFingerprint: artifact.projectFingerprint,
    components,
    flows,
  };
}

function adaptExecutionFlows(artifact, project, repoPath) {
  const validated = validateArtifact(repoPath, artifact);
  if (!validated) {
    return { entities: [], relations: [], executionFlows: [] };
  }

  const flowByComponent = new Map();
  const orderByComponent = new Map();
  const laneOrderByComponent = new Map();
  for (const flow of validated.flows) {
    flow.steps.forEach((componentId, index) => {
      flowByComponent.set(componentId, [
        ...(flowByComponent.get(componentId) || []),
        flow.id,
      ]);
      const orders = orderByComponent.get(componentId) || {};
      orders[flow.id] = index;
      orderByComponent.set(componentId, orders);
      const component = validated.components.find(
        (item) => item.id === componentId,
      );
      const laneOrders = laneOrderByComponent.get(componentId) || {};
      laneOrders[flow.id] = Math.max(0, flow.lanes.indexOf(component?.domain));
      laneOrderByComponent.set(componentId, laneOrders);
    });
  }

  const entityIdByComponent = new Map();
  const entities = validated.components.map((component) => {
    const id = stableId(
      "execution-component",
      `${project.id}:${component.id}`,
    );
    entityIdByComponent.set(component.id, id);
    return {
      id,
      projectId: project.id,
      category: component.category,
      kind: component.kind,
      name: component.name,
      summary: component.summary,
      status: "healthy",
      path: component.path || component.evidence[0]?.file,
      language: component.language,
      layer: component.domain,
      tags: [
        "execution-flow",
        ...(Array.isArray(component.tags) ? component.tags : []),
      ].slice(0, 10),
      metadata: {
        analyzer: "execution-flow",
        execution: true,
        artifactId: component.id,
        domain: component.domain,
        flowIds: [...new Set(flowByComponent.get(component.id) || [])],
        executionOrderByFlow: orderByComponent.get(component.id) || {},
        executionLaneOrderByFlow:
          laneOrderByComponent.get(component.id) || {},
      },
      evidence: component.evidence,
    };
  });

  const relations = [];
  const executionFlows = [];
  for (const flow of validated.flows) {
    const relationIds = [];
    flow.transitions.forEach((transition, index) => {
      const relationId = stableId(
        "execution-relation",
        `${project.id}:${flow.id}:${index}:${transition.source}:${transition.target}`,
      );
      relationIds.push(relationId);
      relations.push({
        id: relationId,
        projectId: project.id,
        source: entityIdByComponent.get(transition.source),
        target: entityIdByComponent.get(transition.target),
        type: transition.type,
        label: transition.label,
        status: "healthy",
        directed: true,
        generated: true,
        metadata: {
          analyzer: "execution-flow",
          execution: true,
          flowId: flow.id,
          flowName: flow.name,
          order: index,
          protocol: transition.protocol,
          returnPath: Boolean(transition.returnPath),
        },
        evidence: transition.evidence,
      });
    });
    executionFlows.push({
      id: flow.id,
      name: flow.name,
      summary: flow.summary,
      entryPoint: flow.entryPoint,
      featured: Boolean(flow.featured),
      entityIds: [
        ...new Set(
          flow.steps.map((componentId) =>
            entityIdByComponent.get(componentId),
          ),
        ),
      ],
      relationIds,
      lanes: flow.lanes,
    });
  }

  return { entities, relations, executionFlows };
}

module.exports = {
  adaptExecutionFlows,
  artifactPath,
  readArtifact,
  validateArtifact,
};
