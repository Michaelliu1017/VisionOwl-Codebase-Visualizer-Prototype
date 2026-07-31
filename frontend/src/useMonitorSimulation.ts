import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { eventTemplates, initialMetrics } from "./mock-data";
import type { MonitorEvent, MonitorMetrics } from "./types";

const BASE_EVENT_DURATION = 920;
const HISTORY_LIMIT = 18;

function clockTime(date = new Date()) {
  return date.toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function materializeEvent(index: number, cycle: number): MonitorEvent {
  return {
    ...eventTemplates[index],
    id: `${cycle}-${index}-${Date.now()}`,
    step: index + 1,
    timestamp: clockTime(),
  };
}

export function useMonitorSimulation() {
  const [cycle, setCycle] = useState(1);
  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [history, setHistory] = useState<MonitorEvent[]>(() => [
    materializeEvent(0, 1),
  ]);
  const indexRef = useRef(0);
  const cycleRef = useRef(cycle);

  useEffect(() => {
    cycleRef.current = cycle;
  }, [cycle]);

  const advance = useCallback(() => {
    const next = (indexRef.current + 1) % eventTemplates.length;
    const wrapped = next === 0;
    const nextCycle = wrapped ? cycleRef.current + 1 : cycleRef.current;

    indexRef.current = next;

    if (wrapped) {
      cycleRef.current = nextCycle;
      setCycle(nextCycle);
    }

    const event = materializeEvent(next, nextCycle);
    setHistory((items) =>
      wrapped ? [event] : [...items, event].slice(-HISTORY_LIMIT),
    );
  }, []);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(advance, BASE_EVENT_DURATION / speed);
    return () => window.clearInterval(timer);
  }, [advance, running, speed]);

  const reset = useCallback(() => {
    indexRef.current = 0;
    cycleRef.current = 1;
    setCycle(1);
    setHistory([materializeEvent(0, 1)]);
    setRunning(true);
  }, []);

  const currentEvent = history.at(-1) ?? materializeEvent(0, cycle);

  const metrics = useMemo<MonitorMetrics>(() => {
    const queueWasPopped = [
      "queue-pop",
      "task-delivered",
      "probe-request",
      "probe-response",
      "report-upload",
      "report-local",
      "report-sls",
    ].includes(currentEvent.kind);

    return {
      ...initialMetrics,
      queued: currentEvent.kind === "worker-dispatch" ? 4 : queueWasPopped ? 3 : 3,
      reports:
        initialMetrics.reports +
        Math.max(0, cycle - 1) +
        (currentEvent.kind === "report-sls" ? 1 : 0),
    };
  }, [currentEvent.kind, cycle]);

  return {
    currentEvent,
    history,
    metrics,
    running,
    speed,
    cycle,
    totalSteps: eventTemplates.length,
    toggleRunning: () => setRunning((value) => !value),
    setSpeed,
    advance,
    reset,
  };
}
