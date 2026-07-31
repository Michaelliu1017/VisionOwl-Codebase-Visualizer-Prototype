import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Copy,
  ExternalLink,
  ShieldAlert,
  X,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import type {
  HealthState,
  MonitorEvent,
  MonitorIncident,
  MonitorMode,
  MonitorNode,
} from "../types";

type NodeInspectorProps = {
  node: MonitorNode | null;
  probeAlerts: ProbeAlertItem[];
  event: MonitorEvent;
  mode: MonitorMode;
  incident?: MonitorIncident | null;
  incidentLoading?: boolean;
  onOpenIncident?: (id: string) => void;
  onSelectProbe: (item: ProbeAlertItem) => void;
  onClose: () => void;
};

export type ProbeAlertItem = {
  node: MonitorNode;
  groupId?: string;
  affectedCount: number;
};

const stateLabel: Record<HealthState, string> = {
  healthy: "正常",
  warning: "受影响",
  error: "故障",
  offline: "证据不足",
};

const confidenceLabel = {
  high: "高",
  medium: "中",
  low: "低",
};

function StateIcon({ state }: { state: HealthState }) {
  if (state === "error") return <XCircle size={16} />;
  if (state === "warning") return <AlertTriangle size={16} />;
  if (state === "offline") return <CircleHelp size={16} />;
  return <CheckCircle2 size={16} />;
}

export function NodeInspector({
  node,
  probeAlerts,
  event,
  mode,
  incident,
  incidentLoading = false,
  onOpenIncident,
  onSelectProbe,
  onClose,
}: NodeInspectorProps) {
  const [copied, setCopied] = useState<string | null>(null);
  const Icon = incident
    ? ShieldAlert
    : (node?.icon ?? (probeAlerts.length > 0 ? ShieldAlert : Activity));

  const copyValue = async (value: string) => {
    await navigator.clipboard?.writeText(value);
    setCopied(value);
    window.setTimeout(() => setCopied(null), 1100);
  };

  const affectedProbeCount = probeAlerts.reduce(
    (total, item) => total + item.affectedCount,
    0,
  );
  const displayTitle =
    incident?.title ??
    node?.title ??
    (probeAlerts.length > 0
      ? `${affectedProbeCount} 个异常探针`
      : "探针运行正常");
  const displayCategory = incident
    ? "INCIDENT DETAIL"
    : node?.category ?? "PROBE HEALTH";
  const nodeState = node?.status ?? "healthy";

  return (
    <aside className="inspector" aria-label="节点详情">
      <div className="inspector__header">
        <div className="inspector__identity">
          <span
            className={`inspector__icon ${
              incident ? "is-error" : node ? `is-${node.status}` : ""
            }`}
          >
            <Icon size={20} strokeWidth={1.8} />
          </span>
          <div>
            <span>{displayCategory}</span>
            <h2>{displayTitle}</h2>
          </div>
        </div>
        {(node || incident) && (
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="关闭节点详情"
            title="关闭"
          >
            <X size={17} />
          </button>
        )}
      </div>

      <div className="inspector__body">
        {incident ? (
          <>
            <p className="inspector__summary">{incident.summary}</p>
            <div className="inspector__state is-error">
              <XCircle size={16} />
              <span>{incident.boundary}</span>
              <strong>
                {incident.statusLabel} · 置信度
                {confidenceLabel[incident.confidence]}
              </strong>
            </div>

            <section className="incident-stats">
              <div>
                <span>探针</span>
                <strong>{incident.affected.probes}</strong>
              </div>
              <div>
                <span>任务</span>
                <strong>{incident.affected.tasks}</strong>
              </div>
              <div>
                <span>目标</span>
                <strong>{incident.affected.targets}</strong>
              </div>
            </section>

            <section className="incident-section">
              <div className="section-label">
                <span>判定证据</span>
                <small>{incident.skill.version}</small>
              </div>
              <ul>
                {incident.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </section>

            <section className="incident-section">
              <div className="section-label">
                <span>仍缺少的证据</span>
              </div>
              <ul className="is-muted">
                {incident.dataGaps.map((gap) => (
                  <li key={gap}>{gap}</li>
                ))}
              </ul>
            </section>

            <section className="incident-section">
              <div className="section-label">
                <span>证据时间线</span>
              </div>
              <div className="incident-timeline">
                {incident.timeline.map((item) => (
                  <div className={`is-${item.severity}`} key={`${item.at}-${item.title}`}>
                    <time>{item.at}</time>
                    <div>
                      <strong>{item.title}</strong>
                      <p>{item.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <div className="incident-source">
              <span>分析来源</span>
              <strong>{incident.skill.id}</strong>
              <small>{incident.skill.source}</small>
            </div>
          </>
        ) : node ? (
          <>
            <p className="inspector__summary">{node.subtitle}</p>
            <div className={`inspector__state is-${node.status}`}>
              <StateIcon state={nodeState} />
              <span>当前状态</span>
              <strong>{node.diagnosis?.statusLabel ?? stateLabel[nodeState]}</strong>
            </div>

            {node.diagnosis && (
              <div className="diagnosis-boundary">
                <span>定界</span>
                <strong>{node.diagnosis.boundary}</strong>
                <small>
                  置信度 {confidenceLabel[node.diagnosis.confidence]}
                </small>
              </div>
            )}

            <dl className="detail-list">
              {node.details.map((detail) => (
                <div className="detail-row" key={`${detail.label}-${detail.value}`}>
                  <dt>{detail.label}</dt>
                  <dd
                    className={[
                      detail.mono ? "is-mono" : "",
                      detail.tone ? `is-${detail.tone}` : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <span>{detail.value}</span>
                    {detail.mono && (
                      <button
                        type="button"
                        className="copy-button"
                        onClick={() => copyValue(detail.value)}
                        aria-label={`复制${detail.label}`}
                        title="复制"
                      >
                        {copied === detail.value ? (
                          <CheckCircle2 size={13} />
                        ) : (
                          <Copy size={13} />
                        )}
                      </button>
                    )}
                  </dd>
                </div>
              ))}
            </dl>

            {node.incidentId && onOpenIncident && (
              <button
                className="incident-open-button"
                type="button"
                onClick={() => onOpenIncident(node.incidentId!)}
                disabled={incidentLoading}
              >
                <ShieldAlert size={15} />
                {incidentLoading ? "正在加载故障证据" : "查看故障分析"}
                <ExternalLink size={13} />
              </button>
            )}
          </>
        ) : probeAlerts.length > 0 ? (
          <div className="probe-alerts">
            <div className="probe-alerts__summary">
              <div>
                <span>当前视图</span>
                <strong>
                  {mode === "online" ? "线上全局" : "本地闭环"}
                </strong>
              </div>
              <div>
                <span>异常节点</span>
                <strong>{affectedProbeCount}</strong>
              </div>
            </div>
            <div className="probe-alerts__label">
              <span>故障与异常探针</span>
              <small>点击查看详情</small>
            </div>
            <div className="probe-alerts__list">
              {probeAlerts.map((item) => (
                <button
                  className={`probe-alert-item is-${item.node.status}`}
                  type="button"
                  key={item.node.id}
                  onClick={() => onSelectProbe(item)}
                >
                  <span className="probe-alert-item__icon">
                    <StateIcon state={item.node.status} />
                  </span>
                  <span className="probe-alert-item__copy">
                    <strong>{item.node.title}</strong>
                    <small>{item.node.subtitle}</small>
                  </span>
                  <span className="probe-alert-item__state">
                    {stateLabel[item.node.status]}
                    {item.affectedCount > 1 && (
                      <small>{item.affectedCount} 个节点</small>
                    )}
                  </span>
                  <ChevronRight size={14} />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="probe-alerts__empty">
            <CheckCircle2 size={20} />
            <strong>未发现异常探针</strong>
            <p>
              当前{mode === "online" ? "线上全局" : "本地闭环"}
              中的探针节点均处于正常状态。
            </p>
          </div>
        )}
      </div>

      <section className="current-event">
        <div className="section-label">
          <span>当前事件</span>
          <time>{event.timestamp}</time>
        </div>
        <strong>{event.title}</strong>
        <p>{event.detail}</p>
        <div className="event-progress">
          <span
            style={{
              width: `${((((event.step - 1) % 15) + 1) / 15) * 100}%`,
            }}
          />
        </div>
      </section>
    </aside>
  );
}
