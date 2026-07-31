"use strict";

const fs = require("node:fs");
const path = require("node:path");

class PluginManager {
  constructor(pluginsRoot) {
    this.pluginsRoot = path.resolve(pluginsRoot);
    this.plugins = new Map();
  }

  load() {
    if (!fs.existsSync(this.pluginsRoot)) return [];
    const directories = fs
      .readdirSync(this.pluginsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const directory of directories) {
      const entry = path.join(this.pluginsRoot, directory.name, "index.js");
      if (!fs.existsSync(entry)) continue;
      const pluginModule = require(entry);
      if (typeof pluginModule.createPlugin !== "function") {
        throw new Error(`Plugin ${directory.name} must export createPlugin().`);
      }
      const plugin = pluginModule.createPlugin();
      const descriptor = plugin.describe();
      if (!descriptor?.id) {
        throw new Error(`Plugin ${directory.name} has no stable id.`);
      }
      if (this.plugins.has(descriptor.id)) {
        throw new Error(`Duplicate plugin id: ${descriptor.id}`);
      }
      this.plugins.set(descriptor.id, plugin);
    }
    return this.list();
  }

  startAll() {
    for (const plugin of this.plugins.values()) plugin.start?.();
  }

  stopAll() {
    for (const plugin of this.plugins.values()) plugin.stop?.();
  }

  list() {
    return [...this.plugins.values()].map((plugin) => plugin.describe());
  }

  get(id) {
    return this.plugins.get(id);
  }

  firstWithCapability(capability) {
    return [...this.plugins.values()].find((plugin) =>
      plugin.describe().capabilities?.includes(capability),
    );
  }
}

module.exports = {
  PluginManager,
};
