import { useCallback, useEffect, useMemo, useState } from "react";
import { monitorEdges, monitorNodes } from "./mock-data";
import { iconForNode } from "./node-icons";
import type {
  HealthSummary,
  MonitorEdge,
  MonitorEvent,
  MonitorIncident,
  MonitorMetrics,
  MonitorMode,
  MonitorNode,
} from "./types";

const API_BASE = (import.meta.env.VITE_MONITOR_API_URL || "").replace(/\/$/, "");
const HISTORY_LIMIT = 18;
const EMPTY_METRICS: MonitorMetrics = {
  workers: 0,
  agentRests: 0,
  probes: 0,
  queued: 0,
  scheduled: 0,
  reports: 0,
  suspected: 0,
  abnormal: 0,
  insufficientEvidence: 0,
  interactions: 0,
};
const WAITING_EVENT: MonitorEvent = {
  id: "waiting-live-event",
  step: 1,
  kind: "probe-register",
  title: "等待实时事件",
  detail: "前端正在连接监控数据源。",
  edgeId: "",
  direction: "forward",
  sourceId: "Monitor",
  targetId: "Runtime",
  severity: "info",
  timestamp: "--:--:--",
  taskId: "waiting",
};

type TopologyNodePayload = Omit<MonitorNode, "icon">;

type TopologyPayload = {
  mode: "live" | "online";
  provider?: string;
  mocked?: boolean;
  workspace?: string;
  region?: string;
  generatedAt: string;
  nodes: TopologyNodePayload[];
  edges: MonitorEdge[];
  metrics: MonitorMetrics;
};

type IncidentPayload = Omit<MonitorIncident, "graph"> & {
  graph: {
    nodes: TopologyNodePayload[];
    edges: MonitorEdge[];
  };
};

function apiUrl(path: string, mode: MonitorMode) {
  const separator = path.includes("?") ? "&" : "?";
  if (API_BASE) return `${API_BASE}${path}${separator}mode=${mode}`;

  const proxyPrefix = mode === "local" ? "/api-local" : "/api-online";
  const routedPath = path.startsWith("/api")
    ? path.replace(/^\/api/, proxyPrefix)
    : path;
  return `${routedPath}${separator}mode=${mode}`;
}

function appendUnique(items: MonitorEvent[], incoming: MonitorEvent[]) {
  const seen = new Set(items.map((item) => item.id));
  const merged = [...items];
  for (const item of incoming) {
    if (!seen.has(item.id)) {
      merged.push(item);
      seen.add(item.id);
    }
  }
  return merged.slice(-HISTORY_LIMIT);
}

function hydrateNode(node: TopologyNodePayload): MonitorNode {
  return {
    ...node,
    icon: iconForNode(node),
  };
}

function mergeNodes(
  payload: TopologyPayload | null,
  mode: MonitorMode,
): MonitorNode[] {
  if (!payload) return mode === "local" ? monitorNodes : [];
  if (mode === "online") return payload.nodes.map(hydrateNode);

  const liveById = new Map(payload.nodes.map((node) => [node.id, node]));
  return monitorNodes.map((base) => {
    const live = liveById.get(base.id);
    return live
      ? {
          ...base,
          ...live,
          icon: base.icon,
          position: base.position,
        }
      : base;
  });
}

function mergeEdges(
  payload: TopologyPayload | null,
  mode: MonitorMode,
): MonitorEdge[] {
  if (!payload?.edges?.length) return mode === "local" ? monitorEdges : [];
  if (mode === "online") return payload.edges;

  const presentationById = new Map(
    monitorEdges.map((edge) => [edge.id, edge]),
  );
  return payload.edges.map((live) => {
    const presentation = presentationById.get(live.id);
    return presentation
      ? {
          ...live,
          ...presentation,
          source: live.source,
          target: live.target,
        }
      : live;
  });
}

export function useMonitorRuntime(mode: MonitorMode) {
  const [topology, setTopology] = useState<TopologyPayload | null>(null);
  const [connected, setConnected] = useState(false);
  const [history, setHistory] = useState<MonitorEvent[]>([]);
  const [lastUpdatedAt, setLastUpdatedAt] = useState("--:--:--");
  const [streamStartCursor, setStreamStartCursor] = useState<number | null>(
    null,
  );
  const [healthSummary, setHealthSummary] = useState<HealthSummary | null>(
    null,
  );
  const [incident, setIncident] = useState<MonitorIncident | null>(null);
  const [incidentLoading, setIncidentLoading] = useState(false);

  const refreshTopology = useCallback(async () => {
    try {
      const response = await fetch(apiUrl("/api/v1/topology", mode), {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`topology ${response.status}`);
      setTopology((await response.json()) as TopologyPayload);
      if (typeof EventSource === "undefined") setConnected(true);
      setLastUpdatedAt(
        new Date().toLocaleTimeString("zh-CN", { hour12: false }),
      );
    } catch (_error) {
      setConnected(false);
    }
  }, [mode]);

  const refreshHealthSummary = useCallback(async () => {
    if (mode !== "online") {
      setHealthSummary(null);
      return;
    }
    try {
      const response = await fetch(apiUrl("/api/v1/health-summary", mode), {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`health summary ${response.status}`);
      setHealthSummary((await response.json()) as HealthSummary);
    } catch (_error) {
      setHealthSummary(null);
    }
  }, [mode]);

  const loadHistory = useCallback(async () => {
    try {
      const response = await fetch(
        apiUrl(`/api/v1/events?limit=${HISTORY_LIMIT}`, mode),
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(`events ${response.status}`);
      const payload = (await response.json()) as {
        events: MonitorEvent[];
        cursor: number;
      };
      setHistory(payload.events.slice(-HISTORY_LIMIT));
      setStreamStartCursor(payload.cursor || 0);
      if (payload.events.length > 0) {
        setLastUpdatedAt(
          payload.events.at(-1)?.timestamp ??
            new Date().toLocaleTimeString("zh-CN", { hour12: false }),
        );
      }
    } catch (_error) {
      setStreamStartCursor(-1);
    }
  }, [mode]);

  const openIncident = useCallback(
    async (id: string) => {
      if (mode !== "online") return null;
      setIncidentLoading(true);
      try {
        const response = await fetch(
          apiUrl(`/api/v1/incidents/${encodeURIComponent(id)}`, mode),
          { cache: "no-store" },
        );
        if (!response.ok) throw new Error(`incident ${response.status}`);
        const payload = (await response.json()) as IncidentPayload;
        const hydrated: MonitorIncident = {
          ...payload,
          graph: {
            nodes: payload.graph.nodes.map(hydrateNode),
            edges: payload.graph.edges,
          },
        };
        setIncident(hydrated);
        return hydrated;
      } finally {
        setIncidentLoading(false);
      }
    },
    [mode],
  );

  const closeIncident = useCallback(() => setIncident(null), []);

  useEffect(() => {
    setTopology(null);
    setConnected(false);
    setHistory([]);
    setStreamStartCursor(null);
    setIncident(null);
    setHealthSummary(null);

    void refreshTopology();
    void refreshHealthSummary();
    void loadHistory();
    const topologyTimer = window.setInterval(refreshTopology, 2000);
    const healthTimer = window.setInterval(refreshHealthSummary, 10000);
    return () => {
      window.clearInterval(topologyTimer);
      window.clearInterval(healthTimer);
    };
  }, [loadHistory, mode, refreshHealthSummary, refreshTopology]);

  useEffect(() => {
    if (streamStartCursor === null) return;
    if (typeof EventSource === "undefined") {
      let cursor = streamStartCursor;
      let disposed = false;
      const pollEvents = async () => {
        try {
          const response = await fetch(
            apiUrl(`/api/v1/events?after=${cursor}&limit=${HISTORY_LIMIT}`, mode),
            { cache: "no-store" },
          );
          if (!response.ok) throw new Error(`events ${response.status}`);
          const payload = (await response.json()) as {
            events: MonitorEvent[];
            cursor: number;
          };
          if (disposed) return;
          cursor = payload.cursor || cursor;
          if (payload.events.length > 0) {
            setHistory((items) => appendUnique(items, payload.events));
            setLastUpdatedAt(
              payload.events.at(-1)?.timestamp ??
                new Date().toLocaleTimeString("zh-CN", { hour12: false }),
            );
          }
          setConnected(true);
        } catch (_error) {
          if (!disposed) setConnected(false);
        }
      };
      void pollEvents();
      const timer = window.setInterval(pollEvents, 2000);
      return () => {
        disposed = true;
        window.clearInterval(timer);
      };
    }

    const source = new EventSource(
      apiUrl(`/api/v1/stream?after=${streamStartCursor}`, mode),
    );
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener("monitor-event", (rawEvent) => {
      const message = rawEvent as MessageEvent<string>;
      try {
        const incoming = JSON.parse(message.data) as MonitorEvent;
        setHistory((items) => appendUnique(items, [incoming]));
        setLastUpdatedAt(
          incoming.timestamp ??
            new Date().toLocaleTimeString("zh-CN", { hour12: false }),
        );
      } catch (_error) {
        // Ignore malformed or partial SSE events.
      }
    });
    return () => source.close();
  }, [mode, streamStartCursor]);

  const live = topology !== null;
  const nodes = useMemo(() => mergeNodes(topology, mode), [mode, topology]);
  const edges = useMemo(() => mergeEdges(topology, mode), [mode, topology]);
  const currentEvent = history.at(-1) ?? WAITING_EVENT;

  return {
    nodes,
    edges,
    currentEvent,
    history,
    metrics: topology?.metrics ?? EMPTY_METRICS,
    live,
    connected,
    lastUpdatedAt,
    provider: topology?.provider,
    workspace: topology?.workspace,
    mocked: Boolean(topology?.mocked),
    healthSummary,
    incident,
    incidentLoading,
    openIncident,
    closeIncident,
  };
}
