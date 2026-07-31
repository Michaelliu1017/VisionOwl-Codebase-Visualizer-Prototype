"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  selectSemanticBatches,
} = require("../src/core/semantic-analyzer");

function batch(batchIndex, filePath, sizeLines, neighborCount = 0) {
  return {
    batchIndex,
    files: [{ path: filePath, sizeLines }],
    neighborMap: {
      [filePath]: Array.from({ length: neighborCount }, (_, index) => ({
        path: `neighbor-${index}.js`,
        batchIndex: index + 10,
      })),
    },
  };
}

test("semantic selection caps large repositories and favors connected batches", () => {
  const values = [
    batch(1, "frontend/view.ts", 200),
    batch(2, "backend/server.ts", 100, 4),
    batch(3, "docs/guide.md", 50),
    batch(4, "scripts/build.js", 500, 1),
  ];

  const selected = selectSemanticBatches(values, 2);
  assert.equal(selected.length, 2);
  assert.ok(selected.some((item) => item.batchIndex === 2));
  assert.ok(selected.every((item) => values.includes(item)));
});

test("semantic selection keeps every batch below the configured cap", () => {
  const values = [
    batch(1, "frontend/view.ts", 200),
    batch(2, "backend/server.ts", 100),
  ];
  assert.deepEqual(selectSemanticBatches(values, 12), values);
});
