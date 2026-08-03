"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { postgresPoolOptions } = require("../src/db/pool-options");

test("PostgreSQL runtime and migrations share strict TLS options", () => {
  const plain = postgresPoolOptions("postgresql://example/visionowl", {
    sslEnabled: false,
  });
  const secure = postgresPoolOptions("postgresql://example/visionowl", {
    sslEnabled: true,
  });

  assert.equal(plain.ssl, undefined);
  assert.deepEqual(secure.ssl, { rejectUnauthorized: true });
});
