"use strict";

const { createCloudApp } = require("./app");
const { loadConfig } = require("./config");
const { MemoryStore } = require("./db/memory-store");
const { PostgresStore } = require("./db/postgres-store");

async function main() {
  const config = loadConfig();
  const store =
    config.store === "memory"
      ? new MemoryStore()
      : new PostgresStore(config.databaseUrl);
  await store.ping();
  const app = createCloudApp({ store, config });
  app.server.listen(config.port, config.host, () => {
    console.log(
      `VisionOwl Cloud Backend listening on http://${config.host}:${config.port} store=${config.store}`,
    );
  });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main };
