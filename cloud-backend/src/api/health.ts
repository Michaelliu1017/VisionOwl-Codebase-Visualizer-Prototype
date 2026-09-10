import type { FastifyPluginAsync } from "fastify";
import { config } from "../config";
import { pingDb } from "../infra/pg";
import { pingRedis } from "../infra/redis";
import { nowIso } from "../lib/time";

/** GET /api/health（公开，契约 §4.9） */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/health", async () => ({
    status: "ok",
    version: config.serviceVersion,
    contract: config.contractVersion,
    time: nowIso(),
  }));

  /** 契约外的运维加法：依赖探针，便于部署排障 */
  app.get("/api/health/deps", async () => {
    const [db, redis] = await Promise.all([pingDb(), pingRedis()]);
    return {
      status: db ? "ok" : "degraded",
      db,
      redis,
      analyzerMode: config.analyzerMode,
      artifactsDir: config.artifactsDir,
      time: nowIso(),
    };
  });
};
