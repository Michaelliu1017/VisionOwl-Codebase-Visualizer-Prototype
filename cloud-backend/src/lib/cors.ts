import { config } from "../config";

export function streamingCorsHeaders(origin: unknown): Record<string, string> {
  if (typeof origin !== "string" || origin.length === 0) return {};
  if (config.corsOrigin === "*") return { "Access-Control-Allow-Origin": "*" };

  const allowed = config.corsOrigin.split(",").map((value) => value.trim());
  if (!allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
  };
}
