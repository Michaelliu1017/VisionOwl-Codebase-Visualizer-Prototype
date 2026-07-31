"use strict";

const net = require("net");

function encodeCommand(args) {
  const parts = [`*${args.length}\r\n`];
  for (const arg of args) {
    const value = Buffer.from(String(arg));
    parts.push(`$${value.length}\r\n`, value, "\r\n");
  }
  return Buffer.concat(
    parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part))),
  );
}

function readLine(buffer, offset) {
  const end = buffer.indexOf("\r\n", offset);
  if (end < 0) return null;
  return {
    text: buffer.toString("utf8", offset, end),
    offset: end + 2,
  };
}

function parseValue(buffer, offset = 0) {
  if (offset >= buffer.length) return null;
  const marker = String.fromCharCode(buffer[offset]);
  const line = readLine(buffer, offset + 1);
  if (!line) return null;

  if (marker === "+") return { value: line.text, offset: line.offset };
  if (marker === "-") {
    const error = new Error(line.text);
    error.code = "REDIS_ERROR";
    return { value: error, offset: line.offset, error: true };
  }
  if (marker === ":") {
    return { value: Number(line.text), offset: line.offset };
  }
  if (marker === "$") {
    const length = Number(line.text);
    if (length === -1) return { value: null, offset: line.offset };
    const end = line.offset + length;
    if (buffer.length < end + 2) return null;
    return {
      value: buffer.toString("utf8", line.offset, end),
      offset: end + 2,
    };
  }
  if (marker === "*") {
    const length = Number(line.text);
    if (length === -1) return { value: null, offset: line.offset };
    const values = [];
    let cursor = line.offset;
    for (let index = 0; index < length; index += 1) {
      const parsed = parseValue(buffer, cursor);
      if (!parsed) return null;
      if (parsed.error) return parsed;
      values.push(parsed.value);
      cursor = parsed.offset;
    }
    return { value: values, offset: cursor };
  }

  const error = new Error(`Unsupported Redis response marker: ${marker}`);
  error.code = "REDIS_PROTOCOL_ERROR";
  throw error;
}

class RedisClient {
  constructor({ host, port, password, timeoutMs = 2000 }) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.timeoutMs = timeoutMs;
  }

  async multi(commands) {
    const wireCommands = this.password
      ? [["AUTH", this.password], ...commands]
      : commands;

    return new Promise((resolve, reject) => {
      const socket = net.createConnection({
        host: this.host,
        port: this.port,
      });
      let buffer = Buffer.alloc(0);
      let cursor = 0;
      const results = [];
      let settled = false;

      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve(value);
      };

      socket.setTimeout(this.timeoutMs);
      socket.on("timeout", () => {
        const error = new Error("Redis request timed out");
        error.code = "REDIS_TIMEOUT";
        finish(error);
      });
      socket.on("error", (error) => finish(error));
      socket.on("connect", () => {
        socket.write(
          Buffer.concat(wireCommands.map((command) => encodeCommand(command))),
        );
      });
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (results.length < wireCommands.length) {
          const parsed = parseValue(buffer, cursor);
          if (!parsed) break;
          if (parsed.error) {
            finish(parsed.value);
            return;
          }
          results.push(parsed.value);
          cursor = parsed.offset;
        }
        if (results.length === wireCommands.length) {
          finish(null, this.password ? results.slice(1) : results);
        }
      });
      socket.on("end", () => {
        if (!settled) {
          const error = new Error("Redis connection ended before all replies");
          error.code = "REDIS_INCOMPLETE_REPLY";
          finish(error);
        }
      });
    });
  }

  async command(...args) {
    const [result] = await this.multi([args]);
    return result;
  }
}

module.exports = {
  RedisClient,
  encodeCommand,
  parseValue,
};
