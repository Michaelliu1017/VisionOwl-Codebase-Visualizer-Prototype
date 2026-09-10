import assert from "node:assert/strict";
import test from "node:test";
import { createZip } from "../../src/artifacts/zip.js";

test("creates a deterministic ZIP archive containing all logical paths", () => {
  const first = createZip([
    { path: "README.md", content: Buffer.from("hello") },
    { path: "modules/api.md", content: Buffer.from("api") },
  ]);
  const second = createZip([
    { path: "modules/api.md", content: Buffer.from("api") },
    { path: "README.md", content: Buffer.from("hello") },
  ]);
  assert.deepEqual(first, second);
  assert.equal(first.readUInt32LE(0), 0x04034b50);
  assert.equal(first.includes(Buffer.from("README.md")), true);
  assert.equal(first.includes(Buffer.from("modules/api.md")), true);
  assert.equal(first.readUInt32LE(first.length - 22), 0x06054b50);
});
