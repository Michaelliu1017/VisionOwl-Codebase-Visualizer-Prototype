"use strict";

const fs = require("fs");
const path = require("path");

function displayTime(value = Date.now()) {
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Asia/Shanghai",
  });
}

class EventBus {
  constructor({ storePath, maxEvents = 600 }) {
    this.storePath = storePath;
    this.maxEvents = maxEvents;
    this.events = [];
    this.clients = new Set();
    this.sequence = 0;
    this.recentSignatures = new Map();
    this.load();
  }

  load() {
    try {
      const content = fs.readFileSync(this.storePath, "utf8");
      const lines = content.trim().split(/\r?\n/).slice(-this.maxEvents);
      for (const line of lines) {
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          this.events.push(event);
          const numericId = Number(event.cursor || 0);
          if (numericId > this.sequence) this.sequence = numericId;
        } catch (_error) {
          // Ignore a partial final line.
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`event store load failed: ${error.message}`);
      }
    }
  }

  append(event) {
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      fs.appendFileSync(this.storePath, `${JSON.stringify(event)}\n`, "utf8");
    } catch (error) {
      console.warn(`event store append failed: ${error.message}`);
    }
  }

  emit(input) {
    const observedAt = input.observedAt || new Date().toISOString();
    const signature =
      input.signature ||
      [
        input.kind,
        input.taskId,
        input.clientId,
        input.transactionId,
        input.source,
        observedAt,
      ].join("|");
    const now = Date.now();
    const previous = this.recentSignatures.get(signature);
    if (previous && now - previous < 5000) return null;
    this.recentSignatures.set(signature, now);

    for (const [key, timestamp] of this.recentSignatures) {
      if (now - timestamp > 60000) this.recentSignatures.delete(key);
    }

    this.sequence += 1;
    const event = {
      id: `live-${this.sequence}`,
      cursor: this.sequence,
      step: this.sequence,
      timestamp: input.timestamp || displayTime(Date.parse(observedAt)),
      observedAt,
      confidence: input.confidence || "observed",
      mocked: Boolean(input.mocked),
      ...input,
    };
    delete event.signature;

    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    this.append(event);
    this.broadcast(event);
    return event;
  }

  list({ after = 0, limit = 200 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
    return this.events
      .filter((event) => Number(event.cursor || 0) > Number(after || 0))
      .slice(-safeLimit);
  }

  broadcast(event) {
    const payload = `id: ${event.cursor}\nevent: monitor-event\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(payload);
      } catch (_error) {
        this.clients.delete(client);
      }
    }
  }

  subscribe(response, after = 0) {
    this.clients.add(response);
    for (const event of this.list({ after, limit: 500 })) {
      response.write(
        `id: ${event.cursor}\nevent: monitor-event\ndata: ${JSON.stringify(event)}\n\n`,
      );
    }
    response.write(
      `event: ready\ndata: ${JSON.stringify({ cursor: this.sequence })}\n\n`,
    );

    const heartbeat = setInterval(() => {
      try {
        response.write(`: heartbeat ${Date.now()}\n\n`);
      } catch (_error) {
        clearInterval(heartbeat);
        this.clients.delete(response);
      }
    }, 15000);

    response.on("close", () => {
      clearInterval(heartbeat);
      this.clients.delete(response);
    });
  }
}

module.exports = {
  EventBus,
  displayTime,
};
