"use strict";

const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "CODEX_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
];

function safeChildEnvironment(overrides = {}) {
  const environment = Object.fromEntries(
    CHILD_ENV_ALLOWLIST.flatMap((name) =>
      typeof process.env[name] === "string" ? [[name, process.env[name]]] : [],
    ),
  );
  for (const [name, value] of Object.entries(overrides)) {
    if (typeof value === "string") environment[name] = value;
  }
  return environment;
}

module.exports = { CHILD_ENV_ALLOWLIST, safeChildEnvironment };
