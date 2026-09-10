/**
 * Cloud API 装配（契约 §3、§9.1）
 * 顺序：插件 → 全局鉴权钩子 → 契约版本头 → 错误处理 → 路由。
 */
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { config } from "./config";
import { ensureArtifactsDir } from "./infra/artifacts";
import { closeDb, pingDb } from "./infra/pg";
import { closeRedis } from "./infra/redis";
import { AppError } from "./lib/errors";
import { sseHub } from "./realtime/sseHub";
import { annotationRoutes } from "./api/annotations";
import { authRoutes } from "./api/auth";
import { chatRoutes } from "./api/chat";
import { documentRoutes } from "./api/documents";
import { eventRoutes } from "./api/events";
import { graphRoutes } from "./api/graph";
import { healthRoutes } from "./api/health";
import { authenticateHook } from "./api/hooks";
import { invitationRoutes } from "./api/invitations";
import { integrationRoutes } from "./api/integrations";
import { jobRoutes } from "./api/jobs";
import { knowledgeRoutes } from "./api/knowledge";
import { memberRoutes } from "./api/members";
import { projectRoutes } from "./api/projects";
import { repositoryRoutes } from "./api/repository";
import { webhookRoutes } from "./webhook/github";
import {
  dispatchPendingIntegrationRuns,
  failTimedOutKnowledgeRuns,
} from "./services/knowledge";
import { failTimedOutSkillLabRuns } from "./services/skillLab";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          'req.headers["x-hub-signature-256"]',
          'req.headers["x-visionowl-service-token"]',
        ],
        censor: "***",
      },
    },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    disableRequestLogging: false,
  });

  await app.register(cors, {
    origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(","),
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type", "Authorization", "X-Client-Version", "Last-Event-ID", "Accept",
      "X-VisionOwl-Service-Token", "X-Content-SHA256",
    ],
    exposedHeaders: ["X-Contract-Version"],
    credentials: false,
  });

  // 只在标注了 config.rateLimit 的路由上生效（登录、chat）
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => ({
      error: { code: "RATE_LIMITED", message: "请求过于频繁，请稍后再试", details: {} },
    }),
  });

  // 每个响应都带契约版本（契约 §3）
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Contract-Version", config.contractVersion);
    return payload;
  });

  // 默认拒绝：白名单之外一律要求 Bearer
  app.addHook("onRequest", authenticateHook);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.statusCode >= 500) req.log.error({ err }, err.message);
      return reply.code(err.statusCode).send(err.toBody());
    }
    // Fastify/JSON 解析类错误 → 400
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 400 || (err as { code?: string }).code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      return reply.code(400).send({
        error: { code: "VALIDATION_FAILED", message: "请求格式非法", details: {} },
      });
    }
    if (statusCode === 429) {
      return reply.code(429).send({
        error: { code: "RATE_LIMITED", message: "请求过于频繁，请稍后再试", details: {} },
      });
    }
    req.log.error({ err }, "未处理异常");
    // message 不得泄漏堆栈（契约 §3.1）
    return reply.code(500).send({
      error: { code: "INTERNAL", message: "服务内部错误", details: {} },
    });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({
      error: { code: "NOT_FOUND", message: `无此端点：${req.method} ${req.url}`, details: {} },
    }),
  );

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(projectRoutes);
  await app.register(invitationRoutes);
  await app.register(memberRoutes);
  await app.register(repositoryRoutes);
  await app.register(jobRoutes);
  await app.register(graphRoutes);
  await app.register(documentRoutes);
  await app.register(annotationRoutes);
  await app.register(chatRoutes);
  await app.register(eventRoutes);
  if (config.knowledgeIntegrationEnabled) {
    await app.register(knowledgeRoutes);
    await app.register(integrationRoutes);
  }
  await app.register(webhookRoutes);

  return app;
}

async function start(): Promise<void> {
  await ensureArtifactsDir();
  const app = await buildApp();

  if (!(await pingDb())) {
    app.log.error("数据库不可达，请检查 DATABASE_URL 与迁移是否已执行");
  }
  sseHub.init();
  let integrationDispatchTimer: NodeJS.Timeout | null = null;
  if (config.knowledgeIntegrationEnabled) {
    const maintainIntegrations = async () => {
      await Promise.all([
        dispatchPendingIntegrationRuns(),
        failTimedOutKnowledgeRuns(),
        failTimedOutSkillLabRuns(),
      ]);
    };
    await maintainIntegrations().catch((err) => {
      app.log.warn({ err }, "首次投递扩展模块任务失败，定时器会重试");
    });
    integrationDispatchTimer = setInterval(() => {
      void maintainIntegrations().catch((err) => {
        app.log.warn({ err }, "重投扩展模块任务失败");
      });
    }, config.integrationDispatchIntervalSeconds * 1000);
    integrationDispatchTimer.unref();
  }

  await app.listen({ host: "0.0.0.0", port: config.port });
  app.log.info(
    `VisionOwl Cloud API 已启动 contract=${config.contractVersion} mode=${config.analyzerMode} artifacts=${config.artifactsDir}`,
  );

  const shutdown = async (signal: string) => {
    app.log.info(`收到 ${signal}，关闭中…`);
    if (integrationDispatchTimer) clearInterval(integrationDispatchTimer);
    sseHub.closeAll();
    await app.close();
    await Promise.allSettled([closeDb(), closeRedis()]);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (require.main === module) {
  void start().catch((err) => {
    console.error("启动失败：", err);
    process.exit(1);
  });
}
