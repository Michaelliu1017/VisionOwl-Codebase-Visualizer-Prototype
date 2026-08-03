#!/usr/bin/env node

import net from "node:net";

const port = Number(process.argv[2]);
const host = process.argv[3] || "127.0.0.1";
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("Usage: check-port.mjs <port> [host]");
  process.exit(2);
}

const server = net.createServer();
server.unref();
server.once("error", () => process.exit(1));
server.listen({ host, port }, () => {
  server.close(() => process.exit(0));
});
