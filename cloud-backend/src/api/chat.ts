import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ServerResponse } from "node:http";
import { config } from "../config";
import { streamingCorsHeaders } from "../lib/cors";
import { AppError } from "../lib/errors";
import { chatBody, parseOrThrow, projectIdParam } from "../schemas/requests";
import { answerQuestion, isSessionExhausted, MAX_TURNS_PER_SESSION } from "../services/chat";
import { currentUserId, requireProjectRole } from "./hooks";

function writeFrame(res: ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 契约 §6 AI 对话（SSE 流）
 * POST /api/projects/:id/chat —— Project 成员均可提问
 * 事件序列：chat.meta → chat.status* → chat.delta* → chat.evidence → chat.action → chat.done
 * 出错走 chat.error（HTTP 已 200，错误只能在流内表达）
 */
export const chatRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/api/projects/:id/chat",
    {
      config: {
        rateLimit: {
          max: config.chatRateMax,
          timeWindow: config.chatRateWindow,
          keyGenerator: (req: FastifyRequest) => req.userId ?? req.ip,
        },
      },
    },
    async (req, reply) => {
      const { id } = parseOrThrow(projectIdParam, req.params);
      await requireProjectRole(req, id, "editor");
      const body = parseOrThrow(chatBody, req.body);
      currentUserId(req);

      const res = reply.raw;
      reply.hijack();
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Contract-Version": config.contractVersion,
        ...streamingCorsHeaders(req.headers.origin),
      });

      let heartbeat: NodeJS.Timeout | null = null;
      try {
        if (await isSessionExhausted(id, body.sessionId ?? null)) {
          writeFrame(res, "chat.error", {
            code: "RATE_LIMITED",
            message: `单会话已达 ${MAX_TURNS_PER_SESSION} 轮上限，请开启新会话`,
          });
          res.end();
          return;
        }

        const sessionId = body.sessionId ?? randomUUID();
        writeFrame(res, "chat.meta", { sessionId });
        heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(": qoder-working\n\n");
        }, 15_000);

        const answer = await answerQuestion({
          projectId: id,
          question: body.question,
          nodeId: body.nodeId ?? null,
          sessionId,
          onStatus: ({ stage, note }) => {
            writeFrame(res, "chat.status", { stage, note });
          },
        });
        clearInterval(heartbeat);
        heartbeat = null;

        for (const chunk of answer.chunks) {
          if (res.writableEnded) return;
          writeFrame(res, "chat.delta", { text: chunk });
          await sleep(20); // 轻微节流，客户端渐显更自然
        }

        if (answer.evidence.length > 0) {
          writeFrame(res, "chat.evidence", { items: answer.evidence });
        }
        if (answer.action) {
          writeFrame(res, "chat.action", {
            type: answer.action.type,
            nodeIds: answer.action.nodeIds,
            edgeIds: answer.action.edgeIds,
          });
        }
        writeFrame(res, "chat.done", {
          sessionId: answer.sessionId,
          credits: answer.credits,
          inferred: answer.inferred,
          provider: answer.provider,
        });
      } catch (err) {
        const code = err instanceof AppError ? err.code : "INTERNAL";
        const message = err instanceof AppError ? err.message : "对话服务内部错误";
        req.log.error({ err }, "chat 失败");
        writeFrame(res, "chat.error", { code, message });
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        if (!res.writableEnded) res.end();
      }
    },
  );
};
