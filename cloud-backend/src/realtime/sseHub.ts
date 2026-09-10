/**
 * SSE Hub（契约 §5）
 * - 按 projectId 分发；25s 心跳注释行；事件自增 id；Last-Event-ID 尽力续传
 * - Redis pub/sub 作背板：多实例部署时跨实例广播；Redis 不可用时退化为本进程广播
 * - 事件只是"提醒 + 局部刷新"信号，一致性由客户端随后的 REST 拉取保证
 */
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { nextEventId, publishEvent, redisSub } from "../infra/redis";
import type { EventType } from "../types";

const HEARTBEAT_MS = 25_000;
const REPLAY_BUFFER = 100;

interface SseEvent {
  id: number;
  type: EventType;
  data: unknown;
}

interface Connection {
  res: ServerResponse;
  projectId: string;
  timer: NodeJS.Timeout;
}

const INSTANCE_ID = randomUUID();

class SseHub {
  private connections = new Map<string, Set<Connection>>();
  private replay = new Map<string, SseEvent[]>();
  private localSeq = new Map<string, number>();
  private subscribed = false;

  /** 订阅 Redis 背板；失败不影响本进程广播 */
  init(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    const sub = redisSub();
    const subscribe = () => {
      void sub.psubscribe("events:*").catch(() => undefined);
    };
    sub.on("ready", subscribe);
    if (sub.status === "ready") subscribe();
    sub.on("pmessage", (_pattern: string, channel: string, message: string) => {
      try {
        const payload = JSON.parse(message) as { origin: string; event: SseEvent };
        if (payload.origin === INSTANCE_ID) return; // 本实例已本地投递，避免重复
        const projectId = channel.slice("events:".length);
        this.deliverLocal(projectId, payload.event);
      } catch {
        /* 脏消息直接忽略 */
      }
    });
  }

  connectionCount(projectId?: string): number {
    if (projectId) return this.connections.get(projectId)?.size ?? 0;
    let total = 0;
    for (const set of this.connections.values()) total += set.size;
    return total;
  }

  /** 接管 HTTP 连接，返回清理函数 */
  attach(
    projectId: string,
    res: ServerResponse,
    lastEventId?: number,
    headers: Record<string, string> = {},
  ): () => void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // nginx 不缓冲 SSE
      ...headers,
    });
    res.write(`: connected ${new Date().toISOString()}\n\n`);

    const timer = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, HEARTBEAT_MS);

    const conn: Connection = { res, projectId, timer };
    let set = this.connections.get(projectId);
    if (!set) {
      set = new Set();
      this.connections.set(projectId, set);
    }
    set.add(conn);

    // Last-Event-ID 尽力续传（缓冲区内的补发）
    if (lastEventId !== undefined) {
      for (const ev of this.replay.get(projectId) ?? []) {
        if (ev.id > lastEventId) this.write(conn, ev);
      }
    }

    const cleanup = () => {
      clearInterval(timer);
      const s = this.connections.get(projectId);
      if (s) {
        s.delete(conn);
        if (s.size === 0) this.connections.delete(projectId);
      }
      if (!res.writableEnded) res.end();
    };
    res.on("close", cleanup);
    res.on("error", cleanup);
    return cleanup;
  }

  /** 发事件：本地立即投递 + Redis 广播给其它实例 */
  async emit(projectId: string, type: EventType, data: unknown): Promise<void> {
    const id = (await nextEventId(projectId)) ?? this.bumpLocal(projectId);
    const event: SseEvent = { id, type, data };
    this.deliverLocal(projectId, event);
    await publishEvent(projectId, JSON.stringify({ origin: INSTANCE_ID, event }));
  }

  /** 同步触发版：调用方不关心投递结果（CRUD 路径不因事件失败而失败） */
  emitAsync(projectId: string, type: EventType, data: unknown): void {
    void this.emit(projectId, type, data).catch(() => undefined);
  }

  private bumpLocal(projectId: string): number {
    const next = (this.localSeq.get(projectId) ?? 0) + 1;
    this.localSeq.set(projectId, next);
    return next;
  }

  private deliverLocal(projectId: string, event: SseEvent): void {
    const buf = this.replay.get(projectId) ?? [];
    buf.push(event);
    while (buf.length > REPLAY_BUFFER) buf.shift();
    this.replay.set(projectId, buf);

    for (const conn of this.connections.get(projectId) ?? []) this.write(conn, event);
  }

  private write(conn: Connection, event: SseEvent): void {
    if (conn.res.writableEnded) return;
    // data 必须单行 JSON（契约 §5）
    conn.res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
  }

  closeAll(): void {
    for (const set of this.connections.values()) {
      for (const conn of set) {
        clearInterval(conn.timer);
        if (!conn.res.writableEnded) conn.res.end();
      }
    }
    this.connections.clear();
  }
}

export const sseHub = new SseHub();

export function parseLastEventId(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}
