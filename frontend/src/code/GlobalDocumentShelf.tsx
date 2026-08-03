import {
  BookOpen,
  ExternalLink,
  LibraryBig,
  Plus,
  X,
} from "lucide-react";
import { useState } from "react";
import type { DocumentBinding } from "@visionowl/contracts";
import { visionApi } from "./api";

export function GlobalDocumentShelf({
  projectId,
  documents,
  moduleDocumentCount,
  showAllDocuments,
  onToggleAll,
  onChanged,
  onAddDocument,
  canEdit = true,
}: {
  projectId: string;
  documents: DocumentBinding[];
  moduleDocumentCount: number;
  showAllDocuments: boolean;
  onToggleAll: () => void;
  onChanged: () => void;
  onAddDocument?: (input: {
    provider: "link" | "dingtalk" | "local";
    title: string;
    url: string;
    summary?: string;
  }) => Promise<unknown>;
  canEdit?: boolean;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [summary, setSummary] = useState("");
  const [saving, setSaving] = useState(false);

  return (
    <section className="vision-global-documents" aria-label="项目全局文档">
      <div className="vision-global-documents__title">
        <BookOpen size={15} />
        <span>
          <strong>全局文档</strong>
          <small>项目架构与公共规范</small>
        </span>
      </div>

      <div className="vision-global-documents__list">
        {documents.map((document) => (
          <a
            key={document.id}
            href={document.url}
            target="_blank"
            rel="noreferrer"
            title={document.summary || document.title}
          >
            <BookOpen size={13} />
            <span>
              <strong>{document.title}</strong>
              <small>{document.summary || document.provider}</small>
            </span>
            <ExternalLink size={12} />
          </a>
        ))}
        {documents.length === 0 && (
          <span className="vision-global-documents__empty">
            暂无全局文档
          </span>
        )}
        {canEdit && (
          <button
            className="vision-global-documents__add"
            type="button"
            title="挂载全局文档"
            aria-label="挂载全局文档"
            onClick={() => setFormOpen((current) => !current)}
          >
            {formOpen ? <X size={14} /> : <Plus size={14} />}
          </button>
        )}
      </div>

      <button
        className={`vision-global-documents__toggle ${
          showAllDocuments ? "is-active" : ""
        }`}
        type="button"
        disabled={moduleDocumentCount === 0}
        aria-pressed={showAllDocuments}
        onClick={onToggleAll}
      >
        <LibraryBig size={14} />
        <span>
          {showAllDocuments ? "收起模块文档" : "显示全部文档"}
          <small>{moduleDocumentCount}</small>
        </span>
      </button>

      {canEdit && formOpen && (
        <form
          className="vision-global-document-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setSaving(true);
            try {
              await (onAddDocument || ((input) => visionApi.addProjectDocument(projectId, input)))({
                provider: url.includes("alidocs") ? "dingtalk" : "link",
                title,
                url,
                summary,
              });
              setTitle("");
              setUrl("");
              setSummary("");
              setFormOpen(false);
              onChanged();
            } finally {
              setSaving(false);
            }
          }}
        >
          <header>
            <span>挂载全局文档</span>
            <button
              type="button"
              aria-label="关闭"
              onClick={() => setFormOpen(false)}
            >
              <X size={13} />
            </button>
          </header>
          <input
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="文档标题"
          />
          <input
            required
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://..."
          />
          <textarea
            rows={2}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            placeholder="文档摘要"
          />
          <button type="submit" disabled={saving}>
            {saving ? "保存中" : "保存全局文档"}
          </button>
        </form>
      )}
    </section>
  );
}
