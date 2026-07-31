import {
  Check,
  Circle,
  FileSearch,
  LoaderCircle,
  Sparkles,
} from "lucide-react";
import { useEffect, useState } from "react";
import type {
  AnalysisEvent,
  AnalysisJob,
  AnalysisPhase,
} from "@visionowl/contracts";

const STAGES: Array<{
  phase: AnalysisPhase;
  label: string;
}> = [
  { phase: "ua_scan", label: "扫描项目" },
  { phase: "ua_analyze", label: "提取结构" },
  { phase: "enriching", label: "语义增强" },
  { phase: "ua_architecture", label: "架构分层" },
  { phase: "ua_tour", label: "构建导览" },
  { phase: "ua_validate", label: "校验结果" },
  { phase: "ua_save", label: "保存图谱" },
];

function elapsedLabel(createdAt: string, now: number) {
  const elapsed = Math.max(0, Math.floor((now - Date.parse(createdAt)) / 1000));
  if (elapsed < 60) return `${elapsed}s`;
  return `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
}

export function AnalysisProgress({
  job,
  events,
}: {
  job: AnalysisJob;
  events: AnalysisEvent[];
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const stages = STAGES;
  const currentEvent = events.at(-1);
  const phase = currentEvent?.phase ?? job.phase;
  const progress = currentEvent?.progress ?? job.progress;
  const message = currentEvent?.message ?? job.message;
  const activeIndex =
    phase === "queued" || phase === "ua_preflight"
      ? -1
      : phase === "facts_ready"
        ? 1
        : phase === "ua_review"
          ? 3
        : phase === "architecture_ready"
          ? 4
      : phase === "completed"
        ? stages.length
        : stages.findIndex((stage) => stage.phase === phase);
  const recentEvents = events.slice(-3).reverse();

  return (
    <aside className="vision-analysis-progress" aria-live="polite">
      <header>
        <span className="vision-analysis-progress__mark">
          <FileSearch size={17} />
        </span>
        <span className="vision-analysis-progress__title">
          <small>DIRECT UNDERSTAND ENGINE · 7 PHASES</small>
          <strong>{message}</strong>
        </span>
        <span className="vision-analysis-progress__percent">{progress}%</span>
      </header>

      <div
        className="vision-analysis-progress__track"
        role="progressbar"
        aria-label="代码仓库分析进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
      >
        <span style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
      </div>

      <div className="vision-analysis-progress__stages">
        {stages.map((stage, index) => {
          const state =
            index < activeIndex ? "is-complete" : index === activeIndex ? "is-active" : "";
          return (
            <span className={state} key={stage.phase}>
              {index < activeIndex ? (
                <Check size={10} />
              ) : index === activeIndex ? (
                <LoaderCircle size={10} />
              ) : (
                <Circle size={8} />
              )}
              {stage.label}
            </span>
          );
        })}
      </div>

      <div className="vision-analysis-progress__activity">
        <span>
          <Sparkles size={11} />
          已运行 {elapsedLabel(job.createdAt, now)}
        </span>
        {recentEvents.length > 0 && (
          <ol>
            {recentEvents.map((event) => (
              <li key={event.id}>
                <time>
                  {new Date(event.createdAt).toLocaleTimeString("zh-CN", {
                    hour12: false,
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </time>
                <span>{event.message}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}
