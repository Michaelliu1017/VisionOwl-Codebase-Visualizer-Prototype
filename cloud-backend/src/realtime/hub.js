"use strict";

class RealtimeHub {
  constructor() {
    this.projects = new Map();
  }

  subscribe(projectId, socket) {
    const sockets = this.projects.get(projectId) || new Set();
    sockets.add(socket);
    this.projects.set(projectId, sockets);
    const remove = () => {
      sockets.delete(socket);
      if (sockets.size === 0) this.projects.delete(projectId);
    };
    socket.once("close", remove);
    socket.once("error", remove);
  }

  publish(event) {
    const payload = JSON.stringify({ event: "project.event", data: event });
    for (const socket of this.projects.get(event.projectId) || []) {
      if (socket.readyState === 1) socket.send(payload);
    }
  }

  close() {
    for (const sockets of this.projects.values()) {
      for (const socket of sockets) socket.close(1001, "Server shutdown");
    }
    this.projects.clear();
  }
}

module.exports = { RealtimeHub };
