"use strict";

const manifest = require("./manifest.json");
const config = require("./config");
const { OnlineMonitor } = require("./online-monitor");
const { RuntimeMonitor } = require("./runtime-monitor");

function genericCategory(node) {
  const category = String(node.category || "").toLowerCase();
  if (category.includes("store") || category.includes("redis")) return "data";
  if (category.includes("target") || category.includes("sink")) return "external";
  return "runtime";
}

function genericTopology(payload, projectId = "runtime:m5") {
  const entities = payload.nodes.map((node) => ({
    id: `runtime:m5:${node.id}`,
    projectId,
    category: genericCategory(node),
    kind: node.entityType || String(node.category || "component").toLowerCase(),
    name: node.title,
    summary: node.subtitle || "",
    status: node.status || "unknown",
    layer: node.region || "m5",
    tags: ["m5", String(node.category || "runtime").toLowerCase()],
    metadata: {
      sourceId: node.id,
      metric: node.metric,
      metricLabel: node.metricLabel,
      details: node.details || [],
      region: node.region,
      codeHints: manifest.codeHints[node.id] || [],
      diagnosis: node.diagnosis,
    },
    evidence: [],
    position: node.position,
  }));
  const bySourceId = new Map(
    entities.map((entity) => [entity.metadata.sourceId, entity.id]),
  );
  const relations = payload.edges
    .filter((edge) => bySourceId.has(edge.source) && bySourceId.has(edge.target))
    .map((edge) => ({
      id: `runtime:m5:${edge.id}`,
      projectId,
      source: bySourceId.get(edge.source),
      target: bySourceId.get(edge.target),
      type: edge.relationKind || edge.flow || "interacts_with",
      label: edge.label,
      status:
        edge.severity === "error"
          ? "error"
          : edge.severity === "warning"
            ? "warning"
            : "healthy",
      directed: true,
      generated: true,
      metadata: {
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
        routePoints: edge.routePoints,
      },
      evidence: [],
    }));
  return {
    provider: manifest.id,
    mocked: Boolean(payload.mocked),
    generatedAt: payload.generatedAt,
    entities,
    relations,
    metrics: payload.metrics || {},
  };
}

class M5Plugin {
  constructor() {
    this.local = new RuntimeMonitor(config);
    this.online = new OnlineMonitor(config);
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.local.start();
    this.online.start();
    this.started = true;
  }

  stop() {
    if (!this.started) return;
    this.local.stop();
    this.online.stop();
    this.started = false;
  }

  monitor(mode) {
    return mode === "online" ? this.online : this.local;
  }

  describe() {
    return {
      ...manifest,
      enabled: this.started,
      mocked: false,
    };
  }

  topology(mode) {
    return this.monitor(mode).topology();
  }

  genericTopology(mode) {
    return genericTopology(this.topology(mode));
  }
}

module.exports = {
  M5Plugin,
  createPlugin: () => new M5Plugin(),
  genericTopology,
};
