import type { CloudRealtimeEvent } from "@visionowl/contracts";
import { cloudApi } from "./cloud-api";
import { cloudApiBase } from "./session-store";

function websocketBase(httpBase: string) {
  const url = new URL(httpBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/$/, "");
}

export function connectProjectRealtime({
  projectId,
  after,
  onEvent,
  onState,
}: {
  projectId: string;
  after: number;
  onEvent: (event: CloudRealtimeEvent) => void;
  onState?: (state: "connecting" | "connected" | "offline") => void;
}) {
  let stopped = false;
  let socket: WebSocket | undefined;
  let retry = 600;
  let cursor = after;

  const connect = async () => {
    if (stopped) return;
    onState?.("connecting");
    try {
      const [{ ticket }, base] = await Promise.all([
        cloudApi.realtimeTicket(projectId),
        cloudApiBase(),
      ]);
      socket = new WebSocket(
        `${websocketBase(base)}/ws/projects/${encodeURIComponent(projectId)}?ticket=${encodeURIComponent(ticket)}&after=${cursor}`,
      );
      socket.onopen = () => {
        retry = 600;
        onState?.("connected");
      };
      socket.onmessage = (message) => {
        const value = JSON.parse(message.data) as {
          event: string;
          data: CloudRealtimeEvent;
        };
        if (value.event !== "project.event") return;
        cursor = Math.max(cursor, value.data.sequence);
        onEvent(value.data);
      };
      socket.onclose = () => {
        onState?.("offline");
        if (stopped) return;
        window.setTimeout(connect, retry);
        retry = Math.min(10_000, retry * 1.8);
      };
      socket.onerror = () => socket?.close();
    } catch (_error) {
      onState?.("offline");
      if (!stopped) {
        window.setTimeout(connect, retry);
        retry = Math.min(10_000, retry * 1.8);
      }
    }
  };

  void connect();
  return () => {
    stopped = true;
    socket?.close();
  };
}
