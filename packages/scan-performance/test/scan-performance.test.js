import assert from "node:assert/strict";
import test from "node:test";

import { compareScanDurations } from "../src/index.js";

test("reports the speedup of an incremental scan", () => {
  assert.deepEqual(
    compareScanDurations({ fullDurationMs: 12_000, incrementalDurationMs: 3_000 }),
    {
      fullDurationMs: 12_000,
      incrementalDurationMs: 3_000,
      savedMs: 9_000,
      speedup: 4,
      faster: true,
    },
  );
});

test("rejects invalid durations", () => {
  assert.throws(
    () => compareScanDurations({ fullDurationMs: 0, incrementalDurationMs: 3_000 }),
    /fullDurationMs must be a positive number/,
  );
});
