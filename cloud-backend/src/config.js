"use strict";

function integer(name, fallback, minimum = 1) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`);
  }
  return value;
}

function loadConfig(overrides = {}) {
  const store = overrides.store || process.env.VISIONOWL_CLOUD_STORE || "postgres";
  const allowedOrigins = (
    overrides.allowedOrigins ||
    process.env.VISIONOWL_ALLOWED_ORIGINS ||
    "http://127.0.0.1:17300,http://localhost:17300,http://127.0.0.1:4173,http://localhost:4173"
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    nodeEnv: overrides.nodeEnv || process.env.NODE_ENV || "development",
    host: overrides.host || process.env.HOST || "127.0.0.1",
    port: Number(overrides.port || process.env.PORT || 17800),
    store,
    databaseUrl: overrides.databaseUrl || process.env.DATABASE_URL || "",
    allowedOrigins,
    accessTokenTtlSeconds:
      overrides.accessTokenTtlSeconds ||
      integer("VISIONOWL_ACCESS_TOKEN_TTL_SECONDS", 3600),
    refreshTokenTtlSeconds:
      overrides.refreshTokenTtlSeconds ||
      integer("VISIONOWL_REFRESH_TOKEN_TTL_SECONDS", 30 * 24 * 3600),
    inviteTtlSeconds:
      overrides.inviteTtlSeconds || integer("VISIONOWL_INVITE_TTL_SECONDS", 7 * 24 * 3600),
    graphMaxBytes:
      overrides.graphMaxBytes || integer("VISIONOWL_GRAPH_MAX_BYTES", 5_000_000, 100_000),
    trustProxy:
      overrides.trustProxy ?? process.env.VISIONOWL_TRUST_PROXY === "true",
  };
}

module.exports = { loadConfig };
