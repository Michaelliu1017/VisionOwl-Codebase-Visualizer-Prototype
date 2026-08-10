# Scan Performance

`@visionowl/scan-performance` compares a full repository scan with an
incremental scan. It reports elapsed time, saved time, and the resulting
speedup so VisionOwl can expose deterministic scan-performance metrics.

## API

`compareScanDurations({ fullDurationMs, incrementalDurationMs })` returns a
small summary containing `savedMs`, `speedup`, and whether the incremental scan
was faster.
