import {
  ArrowRight,
  ArrowUp,
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  FileCode2,
  Lightbulb,
  ListTree,
  LoaderCircle,
  Sparkles,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  ChatAnswer,
  ChatProgress,
  EntityScope,
  GraphEntity,
} from "@visionowl/contracts";
import { visionApi } from "./api";

type DisplayMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  provider?: "codex" | "local-fallback";
  answer?: ChatAnswer;
};

function ChatAnswerView({ answer }: { answer: ChatAnswer }) {
  return (
    <div className="vision-chat-answer">
      <p className="vision-chat-answer__conclusion">{answer.conclusion}</p>

      {answer.purpose && (
        <section>
          <header>
            <Sparkles size={12} />
            <span>模块职责</span>
          </header>
          <p>{answer.purpose}</p>
        </section>
      )}

      {answer.callChain.length > 0 && (
        <section>
          <header>
            <ListTree size={12} />
            <span>调用链</span>
          </header>
          <div className="vision-chat-chain">
            {answer.callChain.map((step, index) => (
              <span className="vision-chat-chain__step" key={`${step}-${index}`}>
                <code>{step}</code>
                {index < answer.callChain.length - 1 && <ArrowRight size={11} />}
              </span>
            ))}
          </div>
        </section>
      )}

      {answer.facts.length > 0 && (
        <section>
          <header>
            <Check size={12} />
            <span>关键事实</span>
          </header>
          <ul>
            {answer.facts.map((fact, index) => (
              <li key={`${fact}-${index}`}>{fact}</li>
            ))}
          </ul>
        </section>
      )}

      {answer.inferences.length > 0 && (
        <section className="is-inference">
          <header>
            <Lightbulb size={12} />
            <span>推断</span>
          </header>
          <ul>
            {answer.inferences.map((inference, index) => (
              <li key={`${inference}-${index}`}>{inference}</li>
            ))}
          </ul>
        </section>
      )}

      {answer.citations.length > 0 && (
        <section className="vision-chat-sources">
          <header>
            <FileCode2 size={12} />
            <span>源码证据</span>
          </header>
          <div>
            {answer.citations.map((citation, index) => (
              <span
                title={citation.excerpt || citation.file}
                key={`${citation.file}-${citation.line ?? index}`}
              >
                <code>
                  {citation.symbol || citation.file.split("/").at(-1)}
                  {citation.line ? `:${citation.line}` : ""}
                </code>
                <small>{citation.file}</small>
              </span>
            ))}
          </div>
        </section>
      )}

      {answer.notes.length > 0 && (
        <div className="vision-chat-answer__notes">
          {answer.notes.map((note, index) => (
            <span key={`${note}-${index}`}>{note}</span>
          ))}
        </div>
      )}
    </div>
  );
}

export function CodeChat({
  projectId,
  entity,
  scope,
  collapsed,
  onToggle,
}: {
  projectId?: string;
  entity?: GraphEntity;
  scope?: EntityScope;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const [question, setQuestion] = useState("");
  const [conversationId, setConversationId] = useState<string>();
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ChatProgress[]>([]);
  const messagesRef = useRef<HTMLDivElement>(null);
  const latestAssistantRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setConversationId(undefined);
    setMessages([]);
    setQuestion("");
    setProgress([]);
  }, [entity?.id, projectId]);

  useEffect(() => {
    const latestMessage = messages.at(-1);
    if (!loading && latestMessage?.role === "assistant") {
      latestAssistantRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
      return;
    }
    messagesRef.current?.scrollTo({
      top: messagesRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [loading, messages, progress]);

  const latestProgress = progress.at(-1);

  return (
    <aside className={`vision-chat ${collapsed ? "is-collapsed" : ""}`}>
      <header>
        <div>
          <span className="vision-chat-mark">
            <Bot size={16} />
          </span>
          {!collapsed && (
            <span>
              <strong>VisionOwl Agent</strong>
              <small>{entity ? entity.name : "等待选择模块"}</small>
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? "展开 AI 对话" : "向右隐藏 AI 对话"}
          title={collapsed ? "展开 AI 对话" : "隐藏 AI 对话"}
        >
          {collapsed ? (
            <ChevronLeft size={16} strokeWidth={1.8} />
          ) : (
            <ChevronRight size={16} strokeWidth={1.8} />
          )}
        </button>
      </header>

      {!collapsed && (
        <>
          <div className="vision-chat-messages" ref={messagesRef}>
            {messages.length === 0 ? (
              <div className="vision-chat-empty">
                <Bot size={18} />
                <span>{entity ? "MODULE CONTEXT READY" : "SELECT A MODULE"}</span>
              </div>
            ) : (
              messages.map((message, index) => (
                <article
                  key={message.id}
                  ref={
                    message.role === "assistant" && index === messages.length - 1
                      ? latestAssistantRef
                      : undefined
                  }
                  className={`is-${message.role} ${
                    message.provider === "local-fallback" ? "is-fallback" : ""
                  }`}
                >
                  <span>{message.role === "user" ? "YOU" : "CODEX"}</span>
                  {message.answer ? (
                    <ChatAnswerView answer={message.answer} />
                  ) : (
                    <p>{message.content}</p>
                  )}
                </article>
              ))
            )}
            {loading && (
              <div className="vision-chat-progress">
                <header>
                  <span>
                    <LoaderCircle size={14} />
                    {latestProgress?.label || "正在启动 Codex"}
                  </span>
                  <small>
                    {latestProgress?.current ?? 1}/{latestProgress?.total ?? 4}
                  </small>
                </header>
                <div className="vision-chat-progress__track">
                  <span
                    style={{
                      width: `${((latestProgress?.current ?? 1) / (latestProgress?.total ?? 4)) * 100}%`,
                    }}
                  />
                </div>
                <div className="vision-chat-progress__steps">
                  {progress.map((item, index) => (
                    <span
                      className={
                        index === progress.length - 1 ? "is-current" : "is-complete"
                      }
                      key={`${item.phase}-${index}`}
                    >
                      <i>{index === progress.length - 1 ? index + 1 : <Check size={8} />}</i>
                      <span>
                        <strong>{item.label}</strong>
                        {item.detail && <small>{item.detail}</small>}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          <form
            className="vision-chat-composer"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!projectId || !entity || !question.trim() || loading) return;
              const value = question.trim();
              setMessages((current) => [
                ...current,
                {
                  id: crypto.randomUUID(),
                  role: "user",
                  content: value,
                },
              ]);
              setQuestion("");
              setLoading(true);
              setProgress([]);
              try {
                const response = await visionApi.chatStream(
                  projectId,
                  {
                    entityId: entity.id,
                    question: value,
                    conversationId,
                    scope,
                  },
                  (nextProgress) => {
                    setProgress((current) => {
                      const existingIndex = current.findIndex(
                        (item) => item.phase === nextProgress.phase,
                      );
                      if (existingIndex < 0) return [...current, nextProgress];
                      return current.map((item, index) =>
                        index === existingIndex ? nextProgress : item,
                      );
                    });
                  },
                );
                setConversationId(response.conversationId);
                setMessages((current) => [
                  ...current,
                  {
                    id: response.message.id,
                    role: "assistant",
                    content: response.message.content,
                    provider: response.message.provider,
                    answer: response.answer,
                  },
                ]);
              } catch (error) {
                setMessages((current) => [
                  ...current,
                  {
                    id: crypto.randomUUID(),
                    role: "assistant",
                    content: (error as Error).message,
                    provider: "local-fallback",
                  },
                ]);
              } finally {
                setLoading(false);
                setProgress([]);
              }
            }}
          >
            <textarea
              rows={2}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              disabled={!entity || loading}
              placeholder={entity ? "询问当前模块..." : "先选择一个代码模块"}
            />
            <button
              type="submit"
              disabled={!entity || !question.trim() || loading}
              aria-label="发送"
            >
              <ArrowUp size={16} />
            </button>
          </form>
        </>
      )}
    </aside>
  );
}
