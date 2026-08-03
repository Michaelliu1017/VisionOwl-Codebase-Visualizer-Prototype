#!/usr/bin/env node

const url = process.argv[2] || "http://127.0.0.1:17800/api/health";
const timeoutMs = Number(process.argv[3] || 12000);
const deadline = Date.now() + timeoutMs;

while (Date.now() < deadline) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(700) });
    const body = await response.json();
    if (response.ok && body.status === "ok" && body.service === "visionowl-cloud") {
      console.log(`VisionOwl Cloud Backend is ready at ${url}`);
      process.exit(0);
    }
  } catch (_error) {
    // Service may still be starting.
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}

console.error(`VisionOwl Cloud Backend was not ready within ${timeoutMs}ms: ${url}`);
process.exit(1);
