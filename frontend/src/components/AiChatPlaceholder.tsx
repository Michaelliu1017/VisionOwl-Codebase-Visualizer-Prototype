import {
  ArrowUp,
  Bot,
  ChevronLeft,
  ChevronRight,
  Sparkles,
} from "lucide-react";
import type { MonitorIncident, MonitorNode } from "../types";

type AiChatPlaceholderProps = {
  collapsed: boolean;
  node: MonitorNode | null;
  incident?: MonitorIncident | null;
  onToggle: () => void;
};

export function AiChatPlaceholder({
  collapsed,
  node,
  incident,
  onToggle,
}: AiChatPlaceholderProps) {
  if (collapsed) {
    return (
      <aside className="ai-chat-panel is-collapsed" aria-label="AI 分析">
        <button
          className="ai-chat-panel__expand"
          type="button"
          onClick={onToggle}
          aria-label="展开 AI 分析"
          title="展开 AI 分析"
        >
          <Bot size={17} />
          <span>AI</span>
          <ChevronLeft size={14} />
        </button>
      </aside>
    );
  }

  const contextTitle = incident?.title ?? node?.title ?? "拨测运行全局";
  const contextId = incident?.id ?? node?.id ?? "尚未选择节点";

  return (
    <aside className="ai-chat-panel" aria-label="AI 分析对话">
      <header className="ai-chat-panel__header">
        <div className="ai-chat-panel__identity">
          <span className="ai-chat-panel__icon" aria-hidden="true">
            <Bot size={18} />
          </span>
          <div>
            <span>AI ANALYSIS</span>
            <strong>节点诊断</strong>
          </div>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={onToggle}
          aria-label="收起 AI 分析"
          title="收起 AI 分析"
        >
          <ChevronRight size={17} />
        </button>
      </header>

      <div className="ai-chat-panel__context">
        <span>当前上下文</span>
        <strong>{contextTitle}</strong>
        <small>{contextId}</small>
      </div>

      <div className="ai-chat-panel__messages">
        <div className="ai-message">
          <span className="ai-message__mark" aria-hidden="true">
            <Sparkles size={14} />
          </span>
          <div>
            <strong>
              {incident ? "故障证据已绑定到对话上下文" : "AI 节点分析将在这里显示"}
            </strong>
            <p>
              {incident
                ? "后续接入 Agent 后，可直接基于健康 Skill 的结论、证据面和数据缺口继续追问。"
                : node
                  ? "后续接入 Agent 后，可围绕当前节点的健康状态、异常证据和受影响链路继续追问。"
                  : "选择一个拓扑节点后，这里将自动绑定节点上下文。"}
            </p>
          </div>
        </div>
      </div>

      <form className="ai-chat-panel__composer">
        <div>
          <input
            id="ai-chat-placeholder"
            type="text"
            placeholder="AI 对话能力接入中"
            disabled
          />
          <button
            className="ai-chat-panel__send"
            type="submit"
            disabled
            aria-label="发送消息"
            title="AI 对话能力接入中"
          >
            <ArrowUp size={16} />
          </button>
        </div>
      </form>
    </aside>
  );
}
