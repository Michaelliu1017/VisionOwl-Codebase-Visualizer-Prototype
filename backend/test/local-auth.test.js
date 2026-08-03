"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { LocalAuth } = require("../src/security/local-auth");

function request({ token, origin = "http://127.0.0.1:4173", host = "127.0.0.1:17300", remoteAddress = "127.0.0.1" } = {}) {
  return {
    headers: {
      host,
      origin,
      ...(token ? { "x-visionowl-local-token": token } : {}),
    },
    socket: { remoteAddress },
  };
}

test("local auth requires loopback transport, allowed origin, and the session token", () => {
  const token = "a".repeat(43);
  const auth = new LocalAuth({
    token,
    allowedOrigins: ["http://127.0.0.1:4173"],
    allowedHosts: ["127.0.0.1:17300"],
  });
  auth.assertRequest(
    request({ token }),
    new URL("http://127.0.0.1:17300/api/health"),
  );
  assert.throws(
    () => auth.assertRequest(request(), new URL("http://127.0.0.1:17300/api/health")),
    { code: "local_auth_required" },
  );
  assert.throws(
    () =>
      auth.assertRequest(
        request({ token, origin: "https://attacker.example" }),
        new URL("http://127.0.0.1:17300/api/health"),
      ),
    { code: "local_api_origin_denied" },
  );
  assert.throws(
    () =>
      auth.assertRequest(
        request({ token, remoteAddress: "10.0.0.8" }),
        new URL("http://127.0.0.1:17300/api/health"),
      ),
    { code: "local_api_non_loopback" },
  );

  auth.assertRequest(
    request(),
    new URL(
      `http://127.0.0.1:17300/api/projects/project-1/events?local_token=${token}`,
    ),
  );
});
