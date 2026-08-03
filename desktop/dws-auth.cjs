"use strict";

const {
  DWS_AUTH_REQUIRED,
  runDws,
} = require("../backend/src/core/dingtalk-documents");

const DWS_AUTH_TIMEOUT = "dws_auth_timeout";

function parseStatus(raw) {
  try {
    const value = JSON.parse(String(raw || ""));
    return {
      authenticated: value.authenticated === true,
      message: value.message || "",
    };
  } catch (_error) {
    return { authenticated: false, message: "" };
  }
}

function codedError(message, code, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code,
  });
}

function createDwsAuthCoordinator({
  run = runDws,
  wait = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  now = () => Date.now(),
  pollIntervalMs = 1500,
  timeoutMs = 10 * 60 * 1000,
} = {}) {
  let inFlight;

  async function status() {
    const raw = await run(["auth", "status", "--format", "json"]);
    return parseStatus(raw);
  }

  async function authenticate() {
    const current = await status();
    if (current.authenticated) {
      return { authenticated: true, alreadyAuthenticated: true };
    }

    try {
      // DWS owns the loopback OAuth flow and opens the DingTalk authorization page.
      await run(["auth", "login", "--recommend"]);
    } catch (error) {
      throw codedError(
        `无法启动钉钉授权：${error.message}`,
        DWS_AUTH_REQUIRED,
        error,
      );
    }

    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      const next = await status();
      if (next.authenticated) {
        return { authenticated: true, alreadyAuthenticated: false };
      }
      await wait(pollIntervalMs);
    }

    throw codedError(
      "等待钉钉授权超时。请在登录页完成授权后重试。",
      DWS_AUTH_TIMEOUT,
    );
  }

  return {
    start() {
      if (!inFlight) {
        inFlight = authenticate().finally(() => {
          inFlight = undefined;
        });
      }
      return inFlight;
    },
  };
}

module.exports = {
  DWS_AUTH_TIMEOUT,
  createDwsAuthCoordinator,
  parseStatus,
};
