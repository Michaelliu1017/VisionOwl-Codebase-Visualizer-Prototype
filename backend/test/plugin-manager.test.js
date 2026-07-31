"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { PluginManager } = require("../src/core/plugin-manager");

test("plugin manager discovers M5 without coupling core code to its constructor", () => {
  const manager = new PluginManager(path.join(__dirname, "..", "src", "plugins"));
  const descriptors = manager.load();
  const plugin = manager.firstWithCapability("runtime-topology");

  assert.ok(
    descriptors.some((descriptor) => descriptor.id === "m5-synthetic-monitor"),
  );
  assert.equal(plugin.describe().id, "m5-synthetic-monitor");
  assert.equal(typeof plugin.genericTopology, "function");
});
