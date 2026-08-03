"use strict";

const { randomBytes, timingSafeEqual } = require("node:crypto");

const LOCAL_TOKEN_HEADER = "x-visionowl-local-token";

class LocalAuthError extends Error {
  constructor(message, status = 401, code = "local_auth_required") {
    super(message);
    this.name = "LocalAuthError";
    this.code = code;
    this.status = status;
  }
}

function createLocalApiToken() {
  return randomBytes(32).toString("base64url");
}

function constantTimeEqual(left, right) {
  const leftValue = Buffer.from(String(left || ""));
  const rightValue = Buffer.from(String(right || ""));
  if (leftValue.length !== rightValue.length) return false;
  return timingSafeEqual(leftValue, rightValue);
}

function loopbackAddress(value) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(String(value || ""));
}

function normalizeOrigins(values) {
  return new Set(
    values
      .map((value) => String(value || "").trim().replace(/\/$/, ""))
      .filter(Boolean),
  );
}

class LocalAuth {
  constructor({ token, allowedOrigins = [], allowedHosts = [] }) {
    if (typeof token !== "string" || token.length < 32) {
      throw new Error("VISIONOWL_LOCAL_TOKEN must contain at least 32 characters.");
    }
    this.token = token;
    this.allowedOrigins = normalizeOrigins(allowedOrigins);
    this.allowedHosts = new Set(allowedHosts.map((value) => String(value).toLowerCase()));
  }

  assertTransport(request) {
    if (!loopbackAddress(request.socket?.remoteAddress)) {
      throw new LocalAuthError(
        "VisionOwl Local API only accepts loopback connections.",
        403,
        "local_api_non_loopback",
      );
    }
    const host = String(request.headers.host || "").toLowerCase();
    if (!host || !this.allowedHosts.has(host)) {
      throw new LocalAuthError(
        "Request Host is not allowed for the VisionOwl Local API.",
        403,
        "local_api_host_denied",
      );
    }
    const origin = String(request.headers.origin || "").replace(/\/$/, "");
    if (origin && !this.allowedOrigins.has(origin)) {
      throw new LocalAuthError(
        "Request Origin is not allowed for the VisionOwl Local API.",
        403,
        "local_api_origin_denied",
      );
    }
  }

  assertPreflight(request) {
    this.assertTransport(request);
  }

  assertRequest(request, requestUrl) {
    this.assertTransport(request);
    const supplied =
      request.headers[LOCAL_TOKEN_HEADER] || requestUrl.searchParams.get("local_token");
    if (!constantTimeEqual(supplied, this.token)) {
      throw new LocalAuthError("A valid VisionOwl Local API token is required.");
    }
  }
}

module.exports = {
  LOCAL_TOKEN_HEADER,
  LocalAuth,
  LocalAuthError,
  constantTimeEqual,
  createLocalApiToken,
  loopbackAddress,
};
