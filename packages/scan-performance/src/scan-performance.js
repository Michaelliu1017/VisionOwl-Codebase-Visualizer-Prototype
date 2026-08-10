function positiveDuration(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number`);
  }
  return value;
}

/** Compare full and incremental scan durations without relying on wall-clock state. */
export function compareScanDurations({ fullDurationMs, incrementalDurationMs }) {
  const full = positiveDuration(fullDurationMs, "fullDurationMs");
  const incremental = positiveDuration(incrementalDurationMs, "incrementalDurationMs");

  return {
    fullDurationMs: full,
    incrementalDurationMs: incremental,
    savedMs: full - incremental,
    speedup: Number((full / incremental).toFixed(2)),
    faster: incremental < full,
  };
}
