import {
  BookOpen,
  ExternalLink,
  FileCode2,
  GitBranch,
  MessageSquarePlus,
  Plus,
  X,
} from "lucide-react";
import { useState } from "react";
import type { EntityContext } from "@visionowl/contracts";
import { visionApi } from "./api";

export function CodeInspector({
  projectId,
  context,
  onClose,
  onChanged,
  onAddDocument,
  onAddAnnotation,
  canEdit = true,
  currentAuthor = "Local user",
}: {
  projectId?: string;
  context?: EntityContext;
  onClose: () => void;
  onChanged: () => void;
  onAddDocument?: (
    entityId: string,
    input: {
      provider: "link" | "dingtalk" | "local";
      title: string;
      url: string;
      summary?: string;
    },
  ) => Promise<unknown>;
  onAddAnnotation?: (entityId: string, body: string) => Promise<unknown>;
  canEdit?: boolean;
  currentAuthor?: string;
}) {
  const [annotation, setAnnotation] = useState("");
  const [author, setAuthor] = useState(currentAuthor);
  const [documentOpen, setDocumentOpen] = useState(false);
  const [documentTitle, setDocumentTitle] = useState("");
  const [documentUrl, setDocumentUrl] = useState("");
  const [documentSummary, setDocumentSummary] = useState("");
  const [saving, setSaving] = useState(false);

  if (!context || !projectId) {
    return (
      <aside className="vision-inspector is-empty">
        <div className="vision-empty-symbol">
          <FileCode2 size={22} />
        </div>
        <strong>未选择代码模块</strong>
        <span>选择节点后显示源码证据、上下游、文档和批注。</span>
      </aside>
    );
  }

  const { entity } = context;
  const isDomain = entity.kind === "domain";
  return (
    <aside className="vision-inspector">
      <header className="vision-panel-head">
        <div>
          <span>{isDomain ? "DOMAIN CONTEXT" : "MODULE CONTEXT"}</span>
          <h2>{entity.name}</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭详情">
          <X size={16} />
        </button>
      </header>

      <div className="vision-panel-scroll">
        <section className="vision-inspector-summary">
          <div className="vision-path">
            <FileCode2 size={13} />
            <span>{entity.path ?? "."}</span>
          </div>
          <p>{entity.summary}</p>
          <div className="vision-tag-list">
            <span>{entity.kind}</span>
            {entity.language && <span>{entity.language}</span>}
            {entity.tags.slice(0, 4).map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>
        </section>

        <section className="vision-inspector-section">
          <div className="vision-section-title">
            <span>关系</span>
            <GitBranch size={14} />
          </div>
          <dl className="vision-relation-counts">
            <div>
              <dt>入向</dt>
              <dd>{context.incoming.length}</dd>
            </div>
            <div>
              <dt>出向</dt>
              <dd>{context.outgoing.length}</dd>
            </div>
            <div>
              <dt>{isDomain ? "成员" : "证据"}</dt>
              <dd>{isDomain ? context.members?.length ?? 0 : entity.evidence.length}</dd>
            </div>
          </dl>
        </section>

        {isDomain && context.members && context.members.length > 0 && (
          <section className="vision-inspector-section">
            <div className="vision-section-title">
              <span>包含模块</span>
              <GitBranch size={14} />
            </div>
            <div className="vision-domain-member-list">
              {context.members.map((member) => (
                <article key={member.id}>
                  <strong>{member.name}</strong>
                  <span>{member.summary || member.path || member.kind}</span>
                </article>
              ))}
            </div>
          </section>
        )}

        <section className="vision-inspector-section">
          <div className="vision-section-title">
            <span>源码证据</span>
            <FileCode2 size={14} />
          </div>
          <div className="vision-evidence-list">
            {entity.evidence.length === 0 ? (
              <p className="vision-inline-empty">该节点暂时没有文件级证据。</p>
            ) : (
              entity.evidence.map((evidence, index) => (
                <article key={`${evidence.file}:${evidence.line ?? index}`}>
                  <strong>{evidence.file}</strong>
                  <span>
                    {evidence.line ? `L${evidence.line}` : "FILE"}
                    {evidence.symbol ? ` · ${evidence.symbol}` : ""}
                  </span>
                  {evidence.excerpt && <p>{evidence.excerpt}</p>}
                </article>
              ))
            )}
          </div>
        </section>

        <section className="vision-inspector-section">
          <div className="vision-section-title">
            <span>关联文档</span>
            {canEdit && (
              <button
                type="button"
                onClick={() => setDocumentOpen((current) => !current)}
                aria-label="关联文档"
              >
                <Plus size={14} />
              </button>
            )}
          </div>
          <div className="vision-document-list">
            {context.documents.map((document) => (
              <a
                key={document.id}
                href={document.url}
                target="_blank"
                rel="noreferrer"
              >
                <BookOpen size={14} />
                <span>
                  <strong>{document.title}</strong>
                  <small>{document.summary || document.provider}</small>
                </span>
                <ExternalLink size={13} />
              </a>
            ))}
            {context.documents.length === 0 && !documentOpen && (
              <p className="vision-inline-empty">暂无关联文档。</p>
            )}
          </div>
          {canEdit && documentOpen && (
            <form
              className="vision-compact-form"
              onSubmit={async (event) => {
                event.preventDefault();
                setSaving(true);
                try {
                  await (onAddDocument || ((entityId, input) => visionApi.addDocument(projectId, entityId, input)))(entity.id, {
                    provider: documentUrl.includes("alidocs") ? "dingtalk" : "link",
                    title: documentTitle,
                    url: documentUrl,
                    summary: documentSummary,
                  });
                  setDocumentTitle("");
                  setDocumentUrl("");
                  setDocumentSummary("");
                  setDocumentOpen(false);
                  onChanged();
                } finally {
                  setSaving(false);
                }
              }}
            >
              <input
                required
                value={documentTitle}
                onChange={(event) => setDocumentTitle(event.target.value)}
                placeholder="文档标题"
              />
              <input
                required
                type="url"
                value={documentUrl}
                onChange={(event) => setDocumentUrl(event.target.value)}
                placeholder="https://..."
              />
              <textarea
                rows={2}
                value={documentSummary}
                onChange={(event) => setDocumentSummary(event.target.value)}
                placeholder="摘要"
              />
              <button type="submit" disabled={saving}>
                {saving ? "保存中" : "保存关联"}
              </button>
            </form>
          )}
        </section>

        <section className="vision-inspector-section">
          <div className="vision-section-title">
            <span>团队批注</span>
            <MessageSquarePlus size={14} />
          </div>
          <div className="vision-annotation-list">
            {context.annotations.map((item) => (
              <article key={item.id}>
                <div>
                  <strong>{item.author}</strong>
                  <time>{new Date(item.createdAt).toLocaleString("zh-CN")}</time>
                </div>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
          {canEdit && (
            <form
              className="vision-compact-form"
              onSubmit={async (event) => {
                event.preventDefault();
                if (!annotation.trim()) return;
                setSaving(true);
                try {
                  if (onAddAnnotation) {
                    await onAddAnnotation(entity.id, annotation);
                  } else {
                    await visionApi.addAnnotation(projectId, entity.id, {
                      author,
                      body: annotation,
                    });
                  }
                  setAnnotation("");
                  onChanged();
                } finally {
                  setSaving(false);
                }
              }}
            >
              <input
                value={author}
                onChange={(event) => setAuthor(event.target.value)}
                placeholder="署名"
                readOnly={Boolean(onAddAnnotation)}
              />
              <textarea
                rows={3}
                value={annotation}
                onChange={(event) => setAnnotation(event.target.value)}
                placeholder="添加批注"
              />
              <button type="submit" disabled={saving || !annotation.trim()}>
                {saving ? "提交中" : "添加批注"}
              </button>
            </form>
          )}
        </section>
      </div>
    </aside>
  );
}
