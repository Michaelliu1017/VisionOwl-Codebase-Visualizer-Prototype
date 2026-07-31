import {
  ChevronDown,
  ChevronUp,
  CircleDot,
  Clock3,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MonitorEvent } from "../types";

type EventTimelineProps = {
  events: MonitorEvent[];
  currentEvent: MonitorEvent;
};

export function EventTimeline({
  events,
  currentEvent,
}: EventTimelineProps) {
  const [collapsed, setCollapsed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      left: scrollRef.current.scrollWidth,
      behavior: "smooth",
    });
  }, [events.length]);

  return (
    <section
      className={`timeline ${collapsed ? "is-collapsed" : ""}`}
      aria-label="实时事件时间线"
    >
      <header className="timeline__header">
        <div>
          <Clock3 size={16} />
          <strong>实时事件</strong>
          <span>{events.length} 条</span>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={() => setCollapsed((value) => !value)}
          aria-label={collapsed ? "展开事件时间线" : "收起事件时间线"}
          title={collapsed ? "展开" : "收起"}
        >
          {collapsed ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
        </button>
      </header>

      {!collapsed && (
        <div className="timeline__track" ref={scrollRef}>
          {events.map((event) => {
            const active = event.id === currentEvent.id;
            return (
              <article
                className={`timeline-event ${active ? "is-active" : ""}`}
                key={event.id}
              >
                <div className="timeline-event__rail">
                  <CircleDot size={15} />
                  <span />
                </div>
                <div className="timeline-event__content">
                  <div>
                    <time>{event.timestamp}</time>
                    <span>STEP {String(event.step).padStart(2, "0")}</span>
                  </div>
                  <strong>{event.title}</strong>
                  <p>{event.detail}</p>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
