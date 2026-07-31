"use strict";

const path = require("path");

const dataRoot = process.env.M5_DATA_ROOT || "/data/m5";
const localMonitorRoot =
  process.env.MONITOR_DATA_ROOT ||
  path.resolve(__dirname, "../../../../data/monitor");

module.exports = {
  host: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT || 17300),
  dataRoot,
  publicRoot:
    process.env.PUBLIC_ROOT || path.resolve(__dirname, "..", "public"),
  eventStore:
    process.env.EVENT_STORE ||
    path.join(localMonitorRoot, "events.ndjson"),
  onlineEventStore:
    process.env.ONLINE_EVENT_STORE ||
    path.join(localMonitorRoot, "online-events.ndjson"),
  redis: {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.REDIS_PORT || 16379),
    password: process.env.REDIS_PASSWORD || "",
  },
  slsEnabled: String(process.env.SLS_ENABLED || "false") === "true",
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 500),
  snapshotIntervalMs: Number(process.env.SNAPSHOT_INTERVAL_MS || 2000),
  online: {
    provider: "mock-umodel",
    workspace:
      process.env.UMODEL_WORKSPACE || "synthetic-monitoring-system-test",
    region: process.env.UMODEL_REGION || "cn-shanghai",
    eventIntervalMs: Number(process.env.ONLINE_EVENT_INTERVAL_MS || 4500),
  },
  files: {
    worker: path.join(dataRoot, "worker", "logs", "worker.log"),
    agentRest: path.join(dataRoot, "agent-rest", "logs", "agent-rest.log"),
    probeIdc: path.join(dataRoot, "goprobe", "logs", "AliProbe.log"),
    probePc: path.join(dataRoot, "goprobe-pc", "logs", "AliProbe.log"),
    reports: path.join(dataRoot, "agent-rest", "reports.ndjson"),
  },
};
