"use strict";

const fs = require("fs");

class FileTailer {
  constructor({
    filePath,
    onLine,
    pollIntervalMs = 500,
    initialBytes = 512 * 1024,
  }) {
    this.filePath = filePath;
    this.onLine = onLine;
    this.pollIntervalMs = pollIntervalMs;
    this.initialBytes = initialBytes;
    this.offset = 0;
    this.buffer = "";
    this.timer = null;
    this.running = false;
    this.lastError = null;
    this.lastReadAt = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.initialize();
    this.timer = setInterval(() => this.readNewContent(), this.pollIntervalMs);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  initialize() {
    try {
      const stat = fs.statSync(this.filePath);
      const start = Math.max(0, stat.size - this.initialBytes);
      const length = stat.size - start;
      if (length <= 0) {
        this.offset = stat.size;
        return;
      }
      const descriptor = fs.openSync(this.filePath, "r");
      const chunk = Buffer.alloc(length);
      fs.readSync(descriptor, chunk, 0, length, start);
      fs.closeSync(descriptor);

      let text = chunk.toString("utf8");
      if (start > 0) {
        const firstBreak = text.indexOf("\n");
        text = firstBreak >= 0 ? text.slice(firstBreak + 1) : "";
      }
      this.offset = stat.size;
      this.consume(text, true);
      this.lastReadAt = new Date().toISOString();
      this.lastError = null;
    } catch (error) {
      if (error.code !== "ENOENT") this.lastError = error.message;
    }
  }

  readNewContent() {
    if (!this.running) return;
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size < this.offset) {
        this.offset = 0;
        this.buffer = "";
      }
      if (stat.size === this.offset) return;

      const length = stat.size - this.offset;
      const descriptor = fs.openSync(this.filePath, "r");
      const chunk = Buffer.alloc(length);
      fs.readSync(descriptor, chunk, 0, length, this.offset);
      fs.closeSync(descriptor);
      this.offset = stat.size;
      this.consume(chunk.toString("utf8"), false);
      this.lastReadAt = new Date().toISOString();
      this.lastError = null;
    } catch (error) {
      if (error.code !== "ENOENT") this.lastError = error.message;
    }
  }

  consume(text, initial) {
    const combined = this.buffer + text;
    const lines = combined.split(/\r?\n/);
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line) continue;
      try {
        this.onLine(line, { initial });
      } catch (error) {
        console.warn(`tail parser failed for ${this.filePath}: ${error.message}`);
      }
    }
  }

  status() {
    return {
      filePath: this.filePath,
      offset: this.offset,
      lastReadAt: this.lastReadAt,
      error: this.lastError,
    };
  }
}

module.exports = {
  FileTailer,
};
