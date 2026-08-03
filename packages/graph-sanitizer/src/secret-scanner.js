"use strict";

const SENSITIVE_KEY =
  /(?:^|[_-])(token|secret|password|passwd|credential|private[_-]?key|access[_-]?key|cookie|authorization|session)(?:$|[_-])/i;

const SECRET_PATTERNS = [
  { name: "private_key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "aliyun_access_key", pattern: /\bLTAI[A-Za-z0-9]{12,}\b/ },
  { name: "github_token", pattern: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{16,}\b/ },
  { name: "openai_key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  {
    name: "assigned_secret",
    pattern:
      /\b(?:token|secret|password|passwd|access[_-]?key|license[_-]?key)\b\s*[:=]\s*["']?[A-Za-z0-9_@./+=-]{12,}/i,
  },
];

const HOST_PATH_PATTERN =
  /(?:\/Users\/|\/home\/|\/root\/|\/private\/|\/apsarapangu\/|[A-Za-z]:\\Users\\)/;

function sensitiveKey(value) {
  return SENSITIVE_KEY.test(String(value || ""));
}

function sensitiveString(value) {
  const text = String(value || "");
  const secret = SECRET_PATTERNS.find(({ pattern }) => pattern.test(text));
  if (secret) return secret.name;
  if (HOST_PATH_PATTERN.test(text)) return "host_absolute_path";
  return undefined;
}

module.exports = {
  HOST_PATH_PATTERN,
  SECRET_PATTERNS,
  sensitiveKey,
  sensitiveString,
};
