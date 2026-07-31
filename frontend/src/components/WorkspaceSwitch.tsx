import { Activity, Network } from "lucide-react";
import type { VisionWorkspace } from "../App";

export function WorkspaceSwitch({
  value,
  onChange,
}: {
  value: VisionWorkspace;
  onChange: (value: VisionWorkspace) => void;
}) {
  return (
    <div className="workspace-switch" aria-label="工作区切换">
      <button
        className={value === "code" ? "is-active" : ""}
        type="button"
        onClick={() => onChange("code")}
      >
        <Network size={14} />
        代码图谱
      </button>
      <button
        className={value === "runtime" ? "is-active" : ""}
        type="button"
        onClick={() => onChange("runtime")}
      >
        <Activity size={14} />
        运行拓扑
      </button>
    </div>
  );
}
