import {
  ArrowRight,
  ArrowUp,
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileCode2,
  FileText,
  Lightbulb,
  ListTree,
  LoaderCircle,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  ChatAnswer,
  ChatProgress,
  DocumentBinding,
  DocumentGenerationProgress,
  DocumentRefreshCompletion,
  DocumentRefreshProgress,
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
  document?: DocumentBinding;
  documentRefresh?: DocumentRefreshCompletion;
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
  documents,
  collapsed,
  onToggle,
  onDocumentCreated,
  onDocumentActivity,
}: {
  projectId?: string;
  entity?: GraphEntity;
  scope?: EntityScope;
  documents: DocumentBinding[];
  collapsed: boolean;
  onToggle: () => void;
  onDocumentCreated?: () => void;
  onDocumentActivity?: (activity?: DocumentUpdateActivity) => void;
}) {
  const [question, setQuestion] = useState("");
  const [conversationId, setConversationId] = useState<string>();
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<
    Array<ChatProgress | DocumentGenerationProgress | DocumentRefreshProgress>
  >([]);
  const messagesRef = useRef<HTMLDivElement>(null);
  const latestAssistantRef = useRef<HTMLElement>(null);
  const activityTimerRef = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (activityTimerRef.current) {
        window.clearTimeout(activityTimerRef.current);
      }
    },
    [],
  );

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
  const refreshableDocuments = documents.filter(
    (document) => document.provider === "dingtalk",
  );

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
                  ) : message.document ? (
                    <div className="vision-chat-document-result">
                      <FileText size={15} />
                      <span>
                        <strong>{message.document.title}</strong>
                        <small>钉钉文档已创建并挂载到当前模块</small>
                      </span>
                      <a
                        href={message.document.url}
                        target="_blank"
                        rel="noreferrer"
                        title="打开钉钉文档"
                      >
                        <ExternalLink size={13} />
                      </a>
                    </div>
                  ) : message.documentRefresh ? (
                    <div className="vision-chat-document-result is-refresh">
                      <RefreshCw size={15} />
                      <span>
                        <strong>关联文档已校准</strong>
                        <small>
                          核对 {message.documentRefresh.checkedDocuments} 篇 · 更新{" "}
                          {message.documentRefresh.updatedDocuments} 篇 · 无需修改{" "}
                          {message.documentRefresh.unchangedDocuments} 篇
                        </small>
                      </span>
                      {message.documentRefresh.documents[0] ? (
                        <a
                          href={message.documentRefresh.documents[0].url}
                          target="_blank"
                          rel="noreferrer"
                          title="打开关联文档"
                        >
                          <ExternalLink size={13} />
                        </a>
                      ) : (
                        <span />
                      )}
                    </div>
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

          <div className="vision-chat-quick-actions">
            <button
              type="button"
              disabled={!projectId || !entity || loading}
              onClick={async () => {
                if (!projectId || !entity || loading) return;
                setMessages((current) => [
                  ...current,
                  {
                    id: crypto.randomUUID(),
                    role: "user",
                    content: `为 ${entity.name} 生成代码文档`,
                  },
                ]);
                setLoading(true);
                setProgress([]);
                try {
                  const response = await visionApi.generateDocumentStream(
                    projectId,
                    entity.id,
                    { scope },
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
                  setMessages((current) => [
                    ...current,
                    {
                      id: crypto.randomUUID(),
                      role: "assistant",
                      content: response.summary,
                      provider: "codex",
                      document: response.document,
                    },
                  ]);
                  onDocumentCreated?.();
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
              <FileText size={13} />
              生成代码文档
            </button>
            <button
              type="button"
              disabled={
                !projectId ||
                !entity ||
                loading ||
                refreshableDocuments.length === 0
              }
              title={
                refreshableDocuments.length > 0
                  ? `分析当前模块并更新 ${refreshableDocuments.length} 篇钉钉关联文档`
                  : "当前模块没有可更新的钉钉关联文档"
              }
              onClick={async () => {
                if (
                  !projectId ||
                  !entity ||
                  loading ||
                  refreshableDocuments.length === 0
                ) {
                  return;
                }
                setMessages((current) => [
                  ...current,
                  {
                    id: crypto.randomUUID(),
                    role: "user",
                    content: `分析 ${entity.name} 并更新关联文档`,
                  },
                ]);
                setLoading(true);
                setProgress([]);
                const initialDocumentTitle =
                  refreshableDocuments[0]?.title ?? "关联文档";
                if (activityTimerRef.current) {
                  window.clearTimeout(activityTimerRef.current);
                }
                onDocumentActivity?.({
                  source: "manual",
                  phase: "context",
                  label: "正在准备模块与文档上下文",
                  documentTitle: initialDocumentTitle,
                  current: 1,
                  total: Math.max(1, 1 + refreshableDocuments.length * 3),
                });
                try {
                  const response = await visionApi.refreshDocumentsStream(
                    projectId,
                    entity.id,
                    { scope },
                    (nextProgress) => {
                      onDocumentActivity?.({
                        source: "manual",
                        phase: nextProgress.phase,
                        label: nextProgress.label,
                        documentTitle:
                          nextProgress.phase === "context"
                            ? initialDocumentTitle
                            : nextProgress.detail || initialDocumentTitle,
                        current: nextProgress.current,
                        total: nextProgress.total,
                      });
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
                  setMessages((current) => [
                    ...current,
                    {
                      id: crypto.randomUUID(),
                      role: "assistant",
                      content: `已核对 ${response.checkedDocuments} 篇关联文档。`,
                      provider: "codex",
                      documentRefresh: response,
                    },
                  ]);
                  onDocumentCreated?.();
                  onDocumentActivity?.({
                    source: "manual",
                    phase: "complete",
                    label: `已完成 ${response.checkedDocuments} 篇文档核对`,
                    documentTitle:
                      response.documents[0]?.title ?? initialDocumentTitle,
                    current: 1,
                    total: 1,
                  });
                  activityTimerRef.current = window.setTimeout(
                    () => onDocumentActivity?.(undefined),
                    1800,
                  );
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
                  onDocumentActivity?.({
                    source: "manual",
                    phase: "error",
                    label: (error as Error).message,
                    documentTitle: initialDocumentTitle,
                    current: 1,
                    total: 1,
                  });
                  activityTimerRef.current = window.setTimeout(
                    () => onDocumentActivity?.(undefined),
                    3600,
                  );
                } finally {
                  setLoading(false);
                  setProgress([]);
                }
              }}
            >
              <RefreshCw size={13} />
              更新关联文档
            </button>
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

export type DocumentUpdateActivity = {
  source: "manual" | "debug";
  phase: string;
  label: string;
  documentTitle: string;
  current: number;
  total: number;
};
