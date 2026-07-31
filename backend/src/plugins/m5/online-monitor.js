"use strict";

const { EventBus } = require("./event-bus");
const {
  eventTemplates,
  incident,
  laneEdges,
  onlineNodes,
  probeHealthSnapshot,
} = require("./online-fixture");

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

class OnlineMonitor {
  constructor(config) {
    this.config = config;
    this.events = new EventBus({ storePath: config.onlineEventStore });
    this.timer = null;
    this.eventIndex = 0;
    this.startedAt = new Date().toISOString();
  }

  start() {
    if (this.timer) return;
    if (this.events.events.length === 0) {
      this.emitNext();
    }
    this.timer = setInterval(
      () => this.emitNext(),
      this.config.online.eventIntervalMs,
    );
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  emitNext() {
    const template = eventTemplates[this.eventIndex % eventTemplates.length];
    this.eventIndex += 1;
    this.events.emit({
      ...template,
      mocked: true,
      confidence: "observed",
      direction: template.direction || "forward",
      taskId: template.incidentId || `online-${this.eventIndex}`,
      observedAt: new Date().toISOString(),
      signature: `online-${this.eventIndex}-${Date.now()}`,
    });
  }

  topology() {
    return {
      mode: "online",
      provider: this.config.online.provider,
      mocked: true,
      workspace: this.config.online.workspace,
      region: this.config.online.region,
      generatedAt: new Date().toISOString(),
      nodes: copy(onlineNodes),
      edges: copy(laneEdges),
      metrics: {
        workers: 24,
        agentRests: 48,
        probes: 3280,
        queued: 0,
        scheduled: 0,
        reports: 18420,
        suspected: probeHealthSnapshot.summary.suspected,
        abnormal: probeHealthSnapshot.summary.abnormal,
        insufficientEvidence:
          probeHealthSnapshot.summary.insufficient_evidence,
        interactions: 18420,
      },
      dataSources: {
        topology: "Mock UModel entity/link provider",
        runtime: "Mock SLS heartbeat and report stream",
        diagnosis: "probe-health-analysis compatible snapshot",
      },
    };
  }

  healthSummary() {
    return {
      generatedAt: new Date().toISOString(),
      mocked: true,
      skill: {
        id: "skill.cms2.synthetics.probe-health-analysis",
        version: "v1.0.0",
      },
      summary: copy(probeHealthSnapshot.summary),
      nodes: copy(probeHealthSnapshot.nodes),
    };
  }

  incidents() {
    return {
      mocked: true,
      incidents: [
        {
          id: incident.id,
          title: incident.title,
          status: incident.status,
          confidence: incident.confidence,
          boundary: incident.boundary,
          affectedGroupId: incident.affectedGroupId,
          updatedAt: incident.updatedAt,
        },
      ],
    };
  }

  incident(id) {
    return id === incident.id ? copy(incident) : null;
  }

  entity(id) {
    const node = onlineNodes.find((candidate) => candidate.id === id);
    if (!node) return null;
    return {
      node: copy(node),
      recentEvents: this.events
        .list({ limit: 200 })
        .filter((item) => item.sourceId === id || item.targetId === id)
        .slice(-30),
      generatedAt: new Date().toISOString(),
      provider: this.config.online.provider,
      mocked: true,
    };
  }

  health() {
    return {
      status: "ok",
      mode: "online",
      provider: this.config.online.provider,
      mocked: true,
      workspace: this.config.online.workspace,
      region: this.config.online.region,
      uptimeSeconds: Math.round(process.uptime()),
      startedAt: this.startedAt,
      eventCursor: this.events.sequence,
    };
  }
}

module.exports = {
  OnlineMonitor,
};
