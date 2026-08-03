"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { safeChildEnvironment } = require("../src/security/child-environment");

test("analysis child processes do not inherit unrelated host credentials", () => {
  const previousSecret = process.env.VISIONOWL_TEST_SECRET;
  process.env.VISIONOWL_TEST_SECRET = "must-not-reach-child";
  try {
    const environment = safeChildEnvironment({ UNDERSTAND_MODE: "direct" });
    assert.equal(environment.VISIONOWL_TEST_SECRET, undefined);
    assert.equal(environment.UNDERSTAND_MODE, "direct");
    assert.equal(typeof environment.PATH, "string");
  } finally {
    if (previousSecret === undefined) delete process.env.VISIONOWL_TEST_SECRET;
    else process.env.VISIONOWL_TEST_SECRET = previousSecret;
  }
});
