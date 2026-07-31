import {
  Activity,
  AlertTriangle,
  Boxes,
  CircleAlert,
  Gauge,
  RadioTower,
  ServerCog,
  Workflow,
} from "lucide-react";
import type { MonitorMetrics, MonitorMode } from "../types";

type MetricStripProps = {
  metrics: MonitorMetrics;
  mode: MonitorMode;
  live?: boolean;
  mocked?: boolean;
};

export function MetricStrip({
  metrics,
  mode,
  live = false,
  mocked = false,
}: MetricStripProps) {
  const items =
    mode === "online"
      ? [
          { label: "Worker", value: metrics.workers, icon: Workflow },
          { label: "Agent-Rest", value: metrics.agentRests, icon: ServerCog },
          { label: "GoProbe", value: metrics.probes, icon: RadioTower },
          {
            label: "疑似",
            value: metrics.suspected ?? 0,
            icon: AlertTriangle,
            tone: "warning",
          },
          {
            label: "故障",
            value: metrics.abnormal ?? 0,
            icon: CircleAlert,
            tone: "error",
          },
          {
            label: "1 分钟交互",
            value: metrics.interactions ?? 0,
            icon: Activity,
          },
        ]
      : [
          { label: "Worker", value: metrics.workers, icon: Workflow },
          { label: "Agent-Rest", value: metrics.agentRests, icon: ServerCog },
          { label: "GoProbe", value: metrics.probes, icon: RadioTower },
          { label: "待执行", value: metrics.queued, icon: Boxes },
          { label: "调度中", value: metrics.scheduled, icon: Gauge },
          { label: "报告累计", value: metrics.reports, icon: Activity },
        ];

  return (
    <section className="metric-strip" aria-label="闭环运行指标">
      <div className="metric-strip__lead">
        <span className={`live-dot ${live ? "" : "is-offline"}`} />
        <div>
          <span>{mode === "online" ? "GLOBAL HEALTH" : "REALTIME LOOP"}</span>
          <strong>
            {mode === "online"
              ? mocked
                ? "线上观测 · Mock"
                : "线上观测中"
              : live
                ? "实时观测中"
                : "等待实时数据"}
          </strong>
        </div>
      </div>

      <div className="metric-strip__scroll">
        {items.map(({ label, value, icon: Icon, tone }) => (
          <div
            className={`metric-item ${tone ? `is-${tone}` : ""}`}
            key={label}
          >
            <Icon size={16} strokeWidth={1.8} />
            <div>
              <span>{label}</span>
              <strong>{Number(value).toLocaleString("zh-CN")}</strong>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
