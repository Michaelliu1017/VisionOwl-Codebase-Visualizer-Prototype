import assert from "node:assert/strict";
import test from "node:test";

import { createEvidenceRecord } from "../src/index.js";

test("creates a stable commit-bound evidence record", () => {
  assert.deepEqual(
    createEvidenceRecord({
      repository: "Michaelliu1017/VisionOwl-Codebase-Visualizer-Prototype",
      commit: "abc1234",
      path: "./cloud-backend/src/app.js",
      line: 42,
    }),
    {
      id: "Michaelliu1017/VisionOwl-Codebase-Visualizer-Prototype@abc1234:cloud-backend/src/app.js:42",
      repository: "Michaelliu1017/VisionOwl-Codebase-Visualizer-Prototype",
      commit: "abc1234",
      path: "cloud-backend/src/app.js",
      line: 42,
    },
  );
});

test("rejects evidence without a valid source line", () => {
  assert.throws(
    () => createEvidenceRecord({ repository: "repo", commit: "abc", path: "src/app.js", line: 0 }),
    /positive integer/,
  );
});
