"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createDwsAuthCoordinator,
  parseStatus,
} = require("../../desktop/dws-auth.cjs");

test("DWS auth coordinator starts OAuth and waits until login completes", async () => {
  const calls = [];
  let statusChecks = 0;
  let clock = 0;
  const coordinator = createDwsAuthCoordinator({
    run: async (args) => {
      calls.push(args);
      if (args[1] === "login") return JSON.stringify({ success: false });
      statusChecks += 1;
      return JSON.stringify({ authenticated: statusChecks >= 3 });
    },
    wait: async (delay) => {
      clock += delay;
    },
    now: () => clock,
    pollIntervalMs: 10,
    timeoutMs: 100,
  });

  const result = await coordinator.start();

  assert.deepEqual(result, {
    authenticated: true,
    alreadyAuthenticated: false,
  });
  assert.equal(calls.filter((args) => args[1] === "login").length, 1);
  assert.equal(calls.filter((args) => args[1] === "status").length, 3);
});

test("DWS auth coordinator shares one login flow between concurrent callers", async () => {
  let loginCalls = 0;
  let authenticated = false;
  const coordinator = createDwsAuthCoordinator({
    run: async (args) => {
      if (args[1] === "login") {
        loginCalls += 1;
        authenticated = true;
        return "{}";
      }
      return JSON.stringify({ authenticated });
    },
    wait: async () => {},
  });

  const [first, second] = await Promise.all([
    coordinator.start(),
    coordinator.start(),
  ]);

  assert.equal(loginCalls, 1);
  assert.equal(first.authenticated, true);
  assert.deepEqual(second, first);
});

test("DWS status parser rejects malformed output", () => {
  assert.deepEqual(parseStatus("not-json"), {
    authenticated: false,
    message: "",
  });
});
