"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const SEMANTIC_CACHE_VERSION = "direct-semantic-v1";

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function cacheKey(value) {
  return createHash("sha256")
    .update(SEMANTIC_CACHE_VERSION)
    .update("\0")
    .update(stableJson(value))
    .digest("hex");
}

function semanticCacheDir(dataDir) {
  return path.join(dataDir, "cache", SEMANTIC_CACHE_VERSION);
}

function readSemanticCache(dataDir, input) {
  const filePath = path.join(semanticCacheDir(dataDir), `${cacheKey(input)}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function writeSemanticCache(dataDir, input, output) {
  const directory = semanticCacheDir(dataDir);
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `${cacheKey(input)}.json`);
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(output, null, 2));
  fs.renameSync(temporary, filePath);
  return filePath;
}

module.exports = {
  SEMANTIC_CACHE_VERSION,
  cacheKey,
  readSemanticCache,
  writeSemanticCache,
};
