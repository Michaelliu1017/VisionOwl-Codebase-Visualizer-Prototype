"use strict";

class CloudError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "CloudError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function assert(condition, status, code, message, details) {
  if (!condition) throw new CloudError(status, code, message, details);
}

module.exports = { CloudError, assert };
