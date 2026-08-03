"use strict";

const fs = require("fs");
const path = require("path");

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function headers(extra = {}) {
  return {
    "Access-Control-Allow-Headers":
      "Content-Type, Last-Event-ID, X-VisionOwl-Local-Token",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Cache-Control": "no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  };
}

function sendJson(response, status, payload) {
  response.writeHead(
    status,
    headers({ "Content-Type": "application/json; charset=utf-8" }),
  );
  response.end(JSON.stringify(payload));
}

function readJson(request, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (_error) {
        reject(Object.assign(new Error("Request body must be valid JSON."), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function serveStatic(publicRoot, pathname, response) {
  const decoded = decodeURIComponent(pathname);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const root = path.resolve(publicRoot);
  let candidate = path.resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    sendJson(response, 400, { error: "invalid_path" });
    return;
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    candidate = path.join(root, "index.html");
  }
  if (!fs.existsSync(candidate)) {
    sendJson(response, 503, {
      error: "frontend_not_built",
      message: "Run npm run build before using the production server.",
    });
    return;
  }
  const realRoot = fs.realpathSync.native(root);
  const realCandidate = fs.realpathSync.native(candidate);
  if (
    realCandidate !== realRoot &&
    !realCandidate.startsWith(`${realRoot}${path.sep}`)
  ) {
    sendJson(response, 400, { error: "invalid_path" });
    return;
  }
  candidate = realCandidate;
  const extension = path.extname(candidate).toLowerCase();
  response.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extension] || "application/octet-stream",
    "Cache-Control": extension === ".html" ? "no-store" : "public, max-age=3600",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  fs.createReadStream(candidate).pipe(response);
}

module.exports = {
  headers,
  readJson,
  sendJson,
  serveStatic,
};
