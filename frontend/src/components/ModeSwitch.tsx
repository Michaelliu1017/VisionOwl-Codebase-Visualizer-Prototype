import { CloudCog, MonitorCog } from "lucide-react";
import type { MonitorMode } from "../types";

type ModeSwitchProps = {
  mode: MonitorMode;
  onChange: (mode: MonitorMode) => void;
};

export function ModeSwitch({ mode, onChange }: ModeSwitchProps) {
  return (
    <div className="mode-switch" aria-label="数据视图">
      <button
        className={mode === "local" ? "is-active" : ""}
        type="button"
        onClick={() => onChange("local")}
        aria-pressed={mode === "local"}
      >
        <MonitorCog size={13} />
        本地 M5
      </button>
      <button
        className={mode === "online" ? "is-active" : ""}
        type="button"
        onClick={() => onChange("online")}
        aria-pressed={mode === "online"}
      >
        <CloudCog size={13} />
        线上 UModel
      </button>
    </div>
  );
}
