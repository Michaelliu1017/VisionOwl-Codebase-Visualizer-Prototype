import { Focus, Network, Play } from "lucide-react";

export type CodeViewMode = "overview" | "focus" | "simulation";

const options: Array<{
  id: CodeViewMode;
  label: string;
  title: string;
  icon: typeof Network;
}> = [
  {
    id: "overview",
    label: "系统全景",
    title: "查看完整代码结构",
    icon: Network,
  },
  {
    id: "focus",
    label: "模块聚焦",
    title: "查看模块上下游、文档与批注",
    icon: Focus,
  },
  {
    id: "simulation",
    label: "路径推演",
    title: "基于源码证据演示可能的交互路径",
    icon: Play,
  },
];

export function CodeModeSwitch({
  value,
  onChange,
}: {
  value: CodeViewMode;
  onChange: (value: CodeViewMode) => void;
}) {
  return (
    <div className="vision-code-mode-switch" aria-label="代码图谱模式">
      {options.map((option) => {
        const Icon = option.icon;
        return (
          <button
            key={option.id}
            className={value === option.id ? "is-active" : ""}
            type="button"
            title={option.title}
            aria-pressed={value === option.id}
            onClick={() => onChange(option.id)}
          >
            <Icon size={14} />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
