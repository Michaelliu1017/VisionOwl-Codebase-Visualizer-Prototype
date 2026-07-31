"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const config = require("./config");
const { OnlineMonitor } = require("./online-monitor");
const { RuntimeMonitor } = require("./runtime-monitor");

const monitor = new RuntimeMonitor(config);
const onlineMonitor = new OnlineMonitor(config);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function commonHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Headers": "Content-Type, Last-Event-ID",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    ...extra,
  };
}

function sendJson(response, status, payload) {
  response.writeHead(
    status,
    commonHeaders({ "Content-Type": "application/json; charset=utf-8" }),
  );
  response.end(JSON.stringify(payload));
}

function safeStaticPath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const candidate = path.resolve(config.publicRoot, relative);
  if (!candidate.startsWith(path.resolve(config.publicRoot) + path.sep)) {
    return null;
  }
  return candidate;
}

function serveStatic(requestPath, response) {
  let candidate = safeStaticPath(requestPath);
  if (!candidate) {
    sendJson(response, 400, { error: "invalid path" });
    return;
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    candidate = path.join(config.publicRoot, "index.html");
  }
  if (!fs.existsSync(candidate)) {
    sendJson(response, 503, { error: "frontend build is not installed" });
    return;
  }
  const extension = path.extname(candidate).toLowerCase();
  response.writeHead(200, {
    "Content-Type": contentTypes[extension] || "application/octet-stream",
    "Cache-Control": extension === ".html" ? "no-store" : "public, max-age=3600",
  });
  fs.createReadStream(candidate)
    .on("error", (error) => sendJson(response, 500, { error: error.message }))
    .pipe(response);
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, "http://localhost");
  const pathname = requestUrl.pathname;
  const selectedMonitor =
    requestUrl.searchParams.get("mode") === "online" ? onlineMonitor : monitor;

  if (request.method === "OPTIONS") {
    response.writeHead(204, commonHeaders());
    response.end();
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, { error: "method not allowed" });
    return;
  }

  if (pathname === "/health") {
    sendJson(response, 200, selectedMonitor.health());
    return;
  }
  if (pathname === "/api/v1/topology") {
    sendJson(response, 200, selectedMonitor.topology());
    return;
  }
  if (pathname === "/api/v1/health-summary") {
    if (selectedMonitor !== onlineMonitor) {
      sendJson(response, 404, { error: "health summary is only available online" });
      return;
    }
    sendJson(response, 200, onlineMonitor.healthSummary());
    return;
  }
  if (pathname === "/api/v1/incidents") {
    if (selectedMonitor !== onlineMonitor) {
      sendJson(response, 200, { mocked: false, incidents: [] });
      return;
    }
    sendJson(response, 200, onlineMonitor.incidents());
    return;
  }
  if (pathname === "/api/v1/events") {
    sendJson(response, 200, {
      events: selectedMonitor.events.list({
        after: requestUrl.searchParams.get("after") || 0,
        limit: requestUrl.searchParams.get("limit") || 200,
      }),
      cursor: selectedMonitor.events.sequence,
    });
    return;
  }
  if (pathname === "/api/v1/stream") {
    response.writeHead(
      200,
      commonHeaders({
        "Content-Type": "text/event-stream; charset=utf-8",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      }),
    );
    const requestedAfter =
      request.headers["last-event-id"] || requestUrl.searchParams.get("after");
    const numericAfter = Number(requestedAfter);
    const after =
      requestedAfter === null ||
      requestedAfter === undefined ||
        !Number.isFinite(numericAfter) ||
        numericAfter < 0
        ? selectedMonitor.events.sequence
        : numericAfter;
    selectedMonitor.events.subscribe(response, after);
    return;
  }

  const incidentMatch = pathname.match(/^\/api\/v1\/incidents\/([^/]+)$/);
  if (incidentMatch) {
    const item =
      selectedMonitor === onlineMonitor
        ? onlineMonitor.incident(decodeURIComponent(incidentMatch[1]))
        : null;
    sendJson(response, item ? 200 : 404, item || { error: "not found" });
    return;
  }

  const entityMatch = pathname.match(/^\/api\/v1\/entities\/([^/]+)$/);
  if (entityMatch) {
    const entity = selectedMonitor.entity(decodeURIComponent(entityMatch[1]));
    sendJson(response, entity ? 200 : 404, entity || { error: "not found" });
    return;
  }

  const executionMatch = pathname.match(
    /^\/api\/v1\/tasks\/([^/]+)\/executions$/,
  );
  if (executionMatch) {
    const taskId = decodeURIComponent(executionMatch[1]);
    sendJson(
      response,
      200,
      selectedMonitor === monitor
        ? monitor.executions(taskId)
        : { taskId, taskUrl: null, reports: [], events: [], mocked: true },
    );
    return;
  }

  serveStatic(pathname, response);
});

monitor.start();
onlineMonitor.start();
server.listen(config.port, config.host, () => {
  console.log(
    `visual-monitor backend listening on http://${config.host}:${config.port}`,
  );
});

function shutdown(signal) {
  console.log(`received ${signal}, shutting down`);
  monitor.stop();
  onlineMonitor.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
