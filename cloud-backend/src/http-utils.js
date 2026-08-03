"use strict";

const { CloudError } = require("./errors");

function sendJson(response, status, value, headers = {}) {
  const body = value === undefined ? "" : JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    ...headers,
  });
  response.end(body);
}

async function readJson(request, maxBytes = 6_000_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new CloudError(413, "request_too_large", "Request body exceeds the size limit.");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (_error) {
    throw new CloudError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

function matchPath(pathname, pattern) {
  const names = [];
  const source = pattern
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        names.push(segment.slice(1));
        return "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  const match = pathname.match(new RegExp(`^${source}/?$`));
  if (!match) return undefined;
  return Object.fromEntries(
    names.map((name, index) => [name, decodeURIComponent(match[index + 1])]),
  );
}

module.exports = { matchPath, readJson, sendJson };
