import process from "node:process";

const base = (process.env.VISIONOWL_CLOUD_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const response = await fetch(`${base}/api/health`);
const body = await response.json().catch(() => ({}));
if (!response.ok || body.status !== "ok" || body.service !== "visionowl-cloud") {
  console.error("VisionOwl Cloud health check failed", response.status, body);
  process.exit(1);
}
console.log(`VisionOwl Cloud is healthy: ${base} store=${body.store}`);
