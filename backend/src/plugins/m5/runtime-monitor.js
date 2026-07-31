"use strict";

const fs = require("fs");
const { URL } = require("url");
const { EventBus } = require("./event-bus");
const { FileTailer } = require("./file-tailer");
const { RedisClient } = require("./redis-client");
const { nodes: baseNodes, edges } = require("./static-topology");

const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function logObservedAt(line) {
  const match = line.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?/,
  );
  if (!match) return new Date().toISOString();
  const [, year, month, day, hour, minute, second, millis = "000"] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}+08:00`;
}

function probeRole(record = {}) {
  const type = String(record.client_type || record.probe_type || "").toLowerCase();
  if (type === "pc" || type === "lastmile" || String(record.agent_type) === "2") {
    return "pc";
  }
  return "idc";
}

function probeNodeId(role) {
  return role === "pc" ? "probe-pc" : "probe-idc";
}

function probeEdgeId(role) {
  return role === "pc" ? "agentrest-pc" : "agentrest-idc";
}

function targetEdgeId(role) {
  return role === "pc" ? "pc-target" : "idc-target";
}

function safeHost(value) {
  try {
    return new URL(value).host || value;
  } catch (_error) {
    return value || "拨测目标";
  }
}

function classifyRedisKey(key) {
  if (key.includes("${20$}")) return "workers";
  if (key.includes("${19$}")) return "worker-heartbeat";
  if (key.includes("${3$")) return "agent";
  if (key.includes("$4${") || key.includes("${4$")) return "task-detail";
  if (key.includes("${7$") && key.endsWith("$hash")) return "queue-dedup";
  if (key.includes("${7$")) return "execution-queue";
  if (key.includes("$8${") || key.includes("${8$")) return "task-route";
  return "other";
}

function parseGetTaskResponse(line) {
  const marker = line.match(/do:\s+GET\[\d+\]\s+(\{.*\})\s*$/);
  if (!marker) return [];
  try {
    const payload = JSON.parse(marker[1]);
    return Array.isArray(payload.data) ? payload.data : [];
  } catch (_error) {
    return [];
  }
}

function parseEncodedRequest(line) {
  const urlMatch = line.match(/https?:\/\/[^\s\]]+/);
  if (!urlMatch) return null;
  try {
    const requestUrl = new URL(urlMatch[0]);
    const body = requestUrl.searchParams.get("body");
    return {
      functionName: requestUrl.searchParams.get("function"),
      body: body ? JSON.parse(body) : {},
    };
  } catch (_error) {
    return null;
  }
}

function event(input) {
  return {
    direction: "forward",
    severity: "info",
    taskId: "runtime",
    ...input,
  };
}

function countTokenInFile(filePath, token) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, "r");
    const chunk = Buffer.alloc(1024 * 1024);
    let carry = "";
    let count = 0;
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      const text = carry + chunk.toString("utf8", 0, bytesRead);
      let index = 0;
      while ((index = text.indexOf(token, index)) >= 0) {
        count += 1;
        index += token.length;
      }
      carry = text.slice(Math.max(0, text.length - token.length + 1));
    } while (bytesRead > 0);
    return count;
  } catch (_error) {
    return 0;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

class RuntimeMonitor {
  constructor(config) {
    this.config = config;
    this.redis = new RedisClient(config.redis);
    this.events = new EventBus({ storePath: config.eventStore });
    this.tailers = [];
    this.snapshotTimer = null;
    this.redisState = {
      connected: false,
      error: null,
      workers: [],
      agents: [],
      taskIds: [],
      queued: 0,
      queueKeys: [],
      capturedAt: null,
    };
    this.reportCount = 0;
    this.recentReports = [];
    this.latestReportByRole = new Map();
    this.latestOnlineByRole = new Map();
    this.clientRoles = new Map();
    this.taskUrls = new Map();
    this.startedAt = new Date().toISOString();
    this.hasStoredEvents = this.events.events.length > 0;
  }

  start() {
    this.reportCount = countTokenInFile(
      this.config.files.reports,
      '"_local_source":"report"',
    );
    const definitions = [
      [this.config.files.worker, (line, meta) => this.parseWorker(line, meta)],
      [
        this.config.files.agentRest,
        (line, meta) => this.parseAgentRest(line, meta),
      ],
      [
        this.config.files.probeIdc,
        (line, meta) => this.parseProbe(line, "idc", meta),
      ],
      [
        this.config.files.probePc,
        (line, meta) => this.parseProbe(line, "pc", meta),
      ],
      [this.config.files.reports, (line, meta) => this.parseReport(line, meta)],
    ];

    for (const [filePath, onLine] of definitions) {
      const tailer = new FileTailer({
        filePath,
        onLine,
        pollIntervalMs: this.config.pollIntervalMs,
        initialBytes: filePath.endsWith("reports.ndjson")
          ? 2 * 1024 * 1024
          : 768 * 1024,
      });
      tailer.start();
      this.tailers.push(tailer);
    }

    this.refreshRedis();
    this.snapshotTimer = setInterval(
      () => this.refreshRedis(),
      this.config.snapshotIntervalMs,
    );
  }

  stop() {
    for (const tailer of this.tailers) tailer.stop();
    this.tailers = [];
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.snapshotTimer = null;
  }

  emit(input, meta = {}) {
    if (meta.initial && this.hasStoredEvents) return null;
    const observedAt = input.observedAt || new Date().toISOString();
    return this.events.emit({
      ...input,
      observedAt,
      confidence: input.confidence || (meta.initial ? "historical" : "observed"),
      signature:
        input.signature ||
        [
          input.kind,
          input.taskId,
          input.clientId,
          input.transactionId,
          observedAt,
        ].join("|"),
    });
  }

  parseWorker(line, meta) {
    const observedAt = logObservedAt(line);
    const taskMatch = line.match(/TaskScheduler\.run\s+:\s+taskId:\s*([0-9a-f-]{36})/i);
    if (taskMatch) {
      this.emit(
        event({
          kind: "worker-scan",
          title: "Worker 扫描到期任务",
          detail: `TaskScheduler 触发 ${taskMatch[1]}`,
          edgeId: "redis-worker",
          sourceId: "task-redis",
          targetId: "worker",
          taskId: taskMatch[1],
          observedAt,
        }),
        meta,
      );
      return;
    }

    const dispatchMatch = line.match(
      /queue\[([^\]]+)\]\s*<-\s*\[(\d+)\]\[([0-9a-f-]{36})\]/i,
    );
    if (dispatchMatch) {
      this.emit(
        event({
          kind: "worker-dispatch",
          title: "Worker 投放执行任务",
          detail: `${dispatchMatch[3]} 已写入 execution queue ${dispatchMatch[1]}`,
          edgeId: "worker-execution",
          sourceId: "worker",
          targetId: "execution-queue",
          taskId: dispatchMatch[3],
          observedAt,
        }),
        meta,
      );
    }
  }

  parseAgentRest(line, meta) {
    const observedAt = logObservedAt(line);
    const taskId = (line.match(UUID_PATTERN) || [])[0];
    if (!taskId) return;

    if (/RPOP|rightPop|popTask|loadTaskDetail/i.test(line)) {
      this.emit(
        event({
          kind: "queue-pop",
          title: "Agent-Rest 消费执行队列",
          detail: "已取出 taskId 并加载最新 TaskDetail",
          edgeId: "execution-agentrest",
          sourceId: "execution-queue",
          targetId: "agent-rest",
          taskId,
          observedAt,
        }),
        meta,
      );
    }
  }

  parseProbe(line, role, meta) {
    const observedAt = logObservedAt(line);
    const request = parseEncodedRequest(line);
    if (request && request.functionName === "get_tasks") {
      const clientId = request.body.client_id || "";
      if (clientId) {
        this.clientRoles.set(clientId, role);
      }
      this.emit(
        event({
          kind: "probe-fetch",
          title: `${role === "pc" ? "PC" : "IDC"} 探针拉取任务`,
          detail: `get_tasks count=${request.body.count || "unknown"}`,
          edgeId: probeEdgeId(role),
          direction: "reverse",
          sourceId: probeNodeId(role),
          targetId: "agent-rest",
          clientId,
          observedAt,
          signature: `fetch|${role}|${observedAt}`,
        }),
        meta,
      );
      return;
    }

    if (request && request.functionName === "report") {
      const body = request.body || {};
      const taskId = body.task_id || "runtime";
      const clientId = body.client_id || "";
      if (clientId) this.clientRoles.set(clientId, role);
      if (body.task_url) this.taskUrls.set(taskId, body.task_url);
      this.emit(
        event({
          kind: "report-upload",
          title: "GoProbe 上报探测结果",
          detail: `function=report，error_code=${body.error_code ?? "unknown"}`,
          edgeId: probeEdgeId(role),
          direction: "reverse",
          sourceId: probeNodeId(role),
          targetId: "agent-rest",
          taskId,
          clientId,
          transactionId: body.transaction_id,
          observedAt,
        }),
        meta,
      );
      return;
    }

    const tasks = parseGetTaskResponse(line);
    for (const task of tasks) {
      const taskId = task.task_id || "runtime";
      if (task.task_url) this.taskUrls.set(taskId, task.task_url);
      this.emit(
        event({
          kind: "queue-pop",
          title: "Agent-Rest 已消费执行队列",
          detail: "任务响应证明 taskId 已出队并加载 TaskDetail",
          edgeId: "execution-agentrest",
          sourceId: "execution-queue",
          targetId: "agent-rest",
          taskId,
          observedAt,
          confidence: "derived",
          signature: `derived-pop|${role}|${taskId}|${observedAt}`,
        }),
        meta,
      );
      this.emit(
        event({
          kind: "task-delivered",
          title: "完整任务 JSON 返回探针",
          detail: `${task.task_name || taskId}，interval=${task.interval || 0}ms`,
          edgeId: probeEdgeId(role),
          sourceId: "agent-rest",
          targetId: probeNodeId(role),
          taskId,
          observedAt,
          signature: `deliver|${role}|${taskId}|${observedAt}`,
        }),
        meta,
      );
    }
  }

  parseReport(line, meta) {
    let record;
    try {
      record = JSON.parse(line);
    } catch (_error) {
      return;
    }

    const role = probeRole(record);
    const clientId = record.client_id || "";
    if (clientId) this.clientRoles.set(clientId, role);

    if (record._local_source !== "report") {
      if (record._topic === "local_online" || record.client_type) {
        this.latestOnlineByRole.set(role, record);
      }
      return;
    }

    const taskId = record.task_id || "runtime";
    const observedAt = record._written_at
      ? new Date(Number(record._written_at)).toISOString()
      : new Date().toISOString();
    const transactionId = record.transaction_id;
    const isError = Number(record.error_code || 0) !== 0;
    const responseCode = record.http_response_code || record.error_code || "--";
    const totalTime = record.total_time_delta || record.total_time || "--";

    if (!meta.initial) this.reportCount += 1;
    this.latestReportByRole.set(role, record);
    if (record.task_url) this.taskUrls.set(taskId, record.task_url);
    this.recentReports.push(record);
    if (this.recentReports.length > 200) this.recentReports.shift();

    this.emit(
      event({
        kind: "probe-request",
        title: "GoProbe 执行真实拨测",
        detail: `${record.request_method || "GET"} ${record.task_url || taskId}`,
        edgeId: targetEdgeId(role),
        sourceId: probeNodeId(role),
        targetId: "target",
        taskId,
        clientId,
        transactionId,
        observedAt,
        confidence: "derived",
        signature: `request|${transactionId || observedAt}`,
      }),
      meta,
    );
    this.emit(
      event({
        kind: "probe-response",
        title: isError ? "拨测目标返回异常" : `目标返回 ${responseCode}`,
        detail: `总耗时 ${totalTime} ms，error_code=${record.error_code || 0}`,
        edgeId: targetEdgeId(role),
        direction: "reverse",
        sourceId: "target",
        targetId: probeNodeId(role),
        severity: isError ? "error" : "info",
        taskId,
        clientId,
        transactionId,
        observedAt,
      }),
      meta,
    );
    this.emit(
      event({
        kind: "report-local",
        title: "报告写入本地 NDJSON",
        detail: "Agent-Rest 已追加 reports.ndjson；SLS 写入保持关闭",
        edgeId: "agentrest-ndjson",
        sourceId: "agent-rest",
        targetId: "ndjson",
        severity: isError ? "warning" : "info",
        taskId,
        clientId,
        transactionId,
        observedAt,
      }),
      meta,
    );
  }

  async scanRedisKeys() {
    let cursor = "0";
    const keys = [];
    do {
      const result = await this.redis.command(
        "SCAN",
        cursor,
        "MATCH",
        "smartalibench*",
        "COUNT",
        "500",
      );
      cursor = String(result[0]);
      keys.push(...(result[1] || []));
    } while (cursor !== "0" && keys.length < 10000);
    return keys;
  }

  async refreshRedis() {
    try {
      const keys = await this.scanRedisKeys();
      const groups = {
        workers: [],
        agent: [],
        "task-detail": [],
        "execution-queue": [],
      };
      for (const key of keys) {
        const type = classifyRedisKey(key);
        if (groups[type]) groups[type].push(key);
      }

      let workers = [];
      if (groups.workers.length > 0) {
        const raw = await this.redis.command("GET", groups.workers[0]);
        if (raw) workers = Object.entries(JSON.parse(raw));
      }

      let queued = 0;
      for (const key of groups["execution-queue"]) {
        const type = await this.redis.command("TYPE", key);
        if (type === "list") {
          queued += Number(await this.redis.command("LLEN", key)) || 0;
        }
      }

      this.redisState = {
        connected: true,
        error: null,
        workers,
        agents: groups.agent,
        taskIds: groups["task-detail"]
          .map((key) => (key.match(UUID_PATTERN) || [])[0])
          .filter(Boolean),
        queued,
        queueKeys: groups["execution-queue"],
        capturedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.redisState = {
        ...this.redisState,
        connected: false,
        error: error.message,
        capturedAt: new Date().toISOString(),
      };
    }
  }

  latestReport() {
    return (
      this.recentReports[this.recentReports.length - 1] ||
      this.latestReportByRole.get("pc") ||
      this.latestReportByRole.get("idc") ||
      null
    );
  }

  nodePatches() {
    const redisStatus = this.redisState.connected ? "healthy" : "error";
    const workerCount = this.redisState.workers.length;
    const agentCount = this.redisState.agents.length;
    const taskCount = this.redisState.taskIds.length;
    const latest = this.latestReport();
    const patches = new Map();

    patches.set("task-redis", {
      status: redisStatus,
      metric: String(taskCount),
      metricLabel: "TASKS",
      details: [
        { label: "监听地址", value: "127.0.0.1:16379", mono: true },
        {
          label: "Redis 状态",
          value: this.redisState.connected ? "connected" : this.redisState.error || "error",
          tone: redisStatus,
        },
        { label: "任务详情", value: `${taskCount} cached` },
      ],
    });
    patches.set("worker", {
      status: workerCount > 0 ? "healthy" : "error",
      metric: String(workerCount),
      metricLabel: "ONLINE",
      details: [
        {
          label: "Worker ID",
          value: this.redisState.workers.map(([id]) => id).join(", ") || "none",
          mono: true,
        },
        {
          label: "负责分桶",
          value:
            this.redisState.workers
              .map(([, value]) => (value.queue || []).join(","))
              .join(" | ") || "none",
          mono: true,
        },
        { label: "调度任务", value: `${taskCount} scheduled` },
      ],
    });
    patches.set("execution-queue", {
      status: redisStatus,
      metric: String(this.redisState.queued),
      metricLabel: "QUEUED",
      details: [
        { label: "当前长度", value: String(this.redisState.queued) },
        { label: "活动队列", value: String(this.redisState.queueKeys.length) },
        { label: "消费方式", value: "RPOP", mono: true },
      ],
    });
    patches.set("agent-cache", {
      status: redisStatus,
      metric: String(agentCount),
      metricLabel: "CLIENTS",
      details: [
        { label: "已注册探针", value: String(agentCount) },
        { label: "数据来源", value: "Redis AgentCache" },
      ],
    });
    patches.set("agent-rest", {
      status: this.tailerStatus("agentRest"),
      metric: "17008",
      metricLabel: "PORT",
      details: [
        { label: "运行模式", value: "local", mono: true },
        { label: "已注册探针", value: String(agentCount) },
        { label: "报告累计（观察窗口）", value: String(this.reportCount) },
      ],
    });

    for (const role of ["idc", "pc"]) {
      const report = this.latestReportByRole.get(role);
      const online = this.latestOnlineByRole.get(role);
      const nodeId = probeNodeId(role);
      const source = report || online;
      patches.set(nodeId, {
        status: source ? "healthy" : "warning",
        metric: source ? String(source.client_version || "LIVE") : "WAIT",
        metricLabel: source ? "VERSION" : "REPORT",
        subtitle:
          role === "pc"
            ? `${source?.city || "北京市"} · PC`
            : `${source?.city || "测试市"} · IDC`,
        details: [
          { label: "Client ID", value: source?.client_id || "waiting", mono: true },
          { label: "类型", value: role === "pc" ? "PC / Lastmile" : "IDC" },
          { label: "版本", value: source?.client_version || "--", mono: true },
          {
            label: "最近上报",
            value: source?.time || source?.client_time || "--",
            tone: source ? "healthy" : "warning",
          },
        ],
      });
    }

    patches.set("ndjson", {
      status: this.tailerStatus("reports"),
      metric: String(this.reportCount),
      metricLabel: "REPORTS",
      details: [
        { label: "写入模式", value: "append only" },
        { label: "观察窗口报告数", value: String(this.reportCount) },
        {
          label: "路径",
          value: "/var/lib/m2/agent-rest/reports.ndjson",
          mono: true,
        },
      ],
    });

    if (latest) {
      const isError = Number(latest.error_code || 0) !== 0;
      patches.set("target", {
        title: safeHost(latest.task_url),
        subtitle: latest.task_name || "真实拨测目标",
        status: isError ? "error" : "healthy",
        metric: String(latest.http_response_code || latest.error_code || "--"),
        metricLabel: latest.http_response_code ? "HTTP" : "RESULT",
        details: [
          { label: "URL", value: latest.task_url || "--", mono: true },
          {
            label: "状态码",
            value: String(latest.http_response_code || "--"),
            tone: isError ? "error" : "healthy",
          },
          {
            label: "总耗时",
            value: `${latest.total_time_delta || latest.total_time || "--"} ms`,
          },
          { label: "远端地址", value: latest.remote_ip || "--", mono: true },
          { label: "error_code", value: String(latest.error_code || 0), mono: true },
        ],
      });
    }

    patches.set("sls", {
      status: this.config.slsEnabled ? "warning" : "offline",
      metric: this.config.slsEnabled ? "ON" : "OFF",
      metricLabel: "DELIVERY",
      subtitle: this.config.slsEnabled
        ? "已配置远端投递"
        : "aidemo 中已关闭远端写入",
      details: [
        {
          label: "SLS_ENABLED",
          value: String(this.config.slsEnabled),
          mono: true,
        },
        {
          label: "数据落点",
          value: this.config.slsEnabled ? "SLS + local NDJSON" : "local NDJSON only",
        },
      ],
    });

    return baseNodes.map((node) => ({ ...node, ...(patches.get(node.id) || {}) }));
  }

  tailerStatus(name) {
    const filePath = this.config.files[name];
    const tailer = this.tailers.find((item) => item.filePath === filePath);
    if (!tailer) return "warning";
    const status = tailer.status();
    return status.error ? "error" : fs.existsSync(filePath) ? "healthy" : "warning";
  }

  topology() {
    return {
      mode: "live",
      generatedAt: new Date().toISOString(),
      nodes: this.nodePatches(),
      edges,
      metrics: {
        workers: this.redisState.workers.length,
        agentRests: this.tailerStatus("agentRest") === "error" ? 0 : 1,
        probes: Math.max(
          this.redisState.agents.length,
          this.latestOnlineByRole.size,
          this.latestReportByRole.size,
        ),
        queued: this.redisState.queued,
        scheduled: this.redisState.taskIds.length,
        reports: this.reportCount,
      },
      dataSources: {
        redis: {
          connected: this.redisState.connected,
          error: this.redisState.error,
          capturedAt: this.redisState.capturedAt,
        },
        files: Object.fromEntries(
          this.tailers.map((tailer) => [
            tailer.filePath,
            tailer.status(),
          ]),
        ),
        slsEnabled: this.config.slsEnabled,
      },
    };
  }

  entity(id) {
    const node = this.nodePatches().find((item) => item.id === id);
    if (!node) return null;
    return {
      node,
      recentEvents: this.events
        .list({ limit: 200 })
        .filter((item) => item.sourceId === id || item.targetId === id)
        .slice(-30),
      generatedAt: new Date().toISOString(),
    };
  }

  executions(taskId) {
    return {
      taskId,
      taskUrl: this.taskUrls.get(taskId) || null,
      reports: this.recentReports
        .filter((report) => report.task_id === taskId)
        .slice(-50),
      events: this.events
        .list({ limit: 500 })
        .filter((item) => item.taskId === taskId)
        .slice(-100),
    };
  }

  health() {
    return {
      status: this.redisState.connected ? "ok" : "degraded",
      uptimeSeconds: Math.round(process.uptime()),
      startedAt: this.startedAt,
      redis: {
        connected: this.redisState.connected,
        error: this.redisState.error,
      },
      eventCursor: this.events.sequence,
      reportCount: this.reportCount,
      slsEnabled: this.config.slsEnabled,
    };
  }
}

module.exports = {
  RuntimeMonitor,
  classifyRedisKey,
  countTokenInFile,
  logObservedAt,
  parseEncodedRequest,
  parseGetTaskResponse,
  probeRole,
  safeHost,
};
