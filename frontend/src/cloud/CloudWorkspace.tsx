import {
  Cloud,
  Copy,
  FolderCode,
  GitBranch,
  KeyRound,
  LoaderCircle,
  LogIn,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Users,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Annotation,
  CloudAnnotation,
  CloudDocument,
  CloudGraphVersion,
  CloudProject,
  CloudProjectInvite,
  CloudProjectMember,
  CloudSession,
  DocumentBinding,
  EntityContext,
  EntityScope,
  GraphEntity,
  GraphVersion,
  Project,
} from "@visionowl/contracts";
import { projectDocumentOwnerId } from "@visionowl/contracts";
import { CodeGraph } from "../code/CodeGraph";
import { CodeChat } from "../code/CodeChat";
import { CodeInspector } from "../code/CodeInspector";
import { CodeModeSwitch, type CodeViewMode } from "../code/CodeModeSwitch";
import { GlobalDocumentShelf } from "../code/GlobalDocumentShelf";
import { visionApi } from "../code/api";
import { buildInteractionPath } from "../code/interaction-path";
import type { CodeDomainLayout } from "../code/layout";
import { cloudApi } from "./cloud-api";
import {
  analyzeAndPublish,
  bindRepository,
  type ProjectSyncProgress,
} from "./project-sync";
import { connectProjectRealtime } from "./realtime-client";
import { cloudApiBase, saveCloudApiBase } from "./session-store";

type Dialog = "create" | "join" | "invite" | "sync" | "versions" | "members";

const emptyGraph: GraphVersion = {
  id: "",
  projectId: "",
  source: "import",
  createdAt: "",
  entities: [],
  relations: [],
};

function graphFromCloud(version: CloudGraphVersion | null): GraphVersion {
  if (!version?.artifact) return emptyGraph;
  return {
    id: version.id,
    projectId: version.projectId,
    source: "import",
    branch: version.branch,
    commit: version.commit,
    createdAt: version.createdAt,
    entities: version.artifact.graph.entities.map((entity) => ({
      ...entity,
      projectId: version.projectId,
    })),
    relations: version.artifact.graph.relations.map((relation) => ({
      ...relation,
      projectId: version.projectId,
    })),
    executionFlows: version.artifact.graph.executionFlows,
  };
}

function documentBinding(document: CloudDocument): DocumentBinding {
  return {
    id: document.id,
    projectId: document.projectId,
    entityId:
      document.scope === "global"
        ? projectDocumentOwnerId(document.projectId)
        : document.stableEntityId || "",
    provider: document.provider,
    externalId: document.externalId,
    title: document.title,
    url: document.url,
    summary: document.summary,
    syncStatus: document.syncStatus,
    updatedAt: document.updatedAt,
  };
}

function annotationBinding(annotation: CloudAnnotation): Annotation {
  return {
    id: annotation.id,
    projectId: annotation.projectId,
    entityId: annotation.stableEntityId,
    author: annotation.author,
    body: annotation.body,
    createdAt: annotation.createdAt,
  };
}

function domainScope(domain: CodeDomainLayout): EntityScope {
  return {
    id: domain.id,
    name: domain.label,
    path: domain.key,
    summary: `${domain.label} 包含 ${domain.entityIds.length} 个共享图谱模块。`,
    entityIds: domain.entityIds,
  };
}

function domainContext(
  projectId: string,
  graph: GraphVersion,
  scope: EntityScope,
  documents: DocumentBinding[],
  annotations: Annotation[],
): EntityContext {
  const ids = new Set(scope.entityIds);
  const members = graph.entities.filter((entity) => ids.has(entity.id));
  const internal = graph.relations.filter(
    (relation) => ids.has(relation.source) && ids.has(relation.target),
  );
  const entity: GraphEntity = {
    id: scope.id,
    projectId,
    category: "code",
    kind: "domain",
    name: scope.name,
    summary: scope.summary || "共享代码域",
    status: "healthy",
    path: scope.path,
    tags: ["domain", "cloud"],
    metadata: { memberCount: members.length },
    evidence: [],
  };
  return {
    entity,
    members,
    internal,
    incoming: graph.relations.filter(
      (relation) => !ids.has(relation.source) && ids.has(relation.target),
    ),
    outgoing: graph.relations.filter(
      (relation) => ids.has(relation.source) && !ids.has(relation.target),
    ),
    documents: documents.filter((document) => document.entityId === scope.id),
    annotations: annotations.filter((annotation) => annotation.entityId === scope.id),
  };
}

function CloudAuth({ onAuthenticated }: { onAuthenticated: (session: CloudSession) => void }) {
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void cloudApiBase().then(setEndpoint);
  }, []);

  return (
    <main className="vision-cloud-auth">
      <section>
        <img src="/hackowl.png" alt="" />
        <span>VISIONOWL CLOUD</span>
        <h1>{register ? "创建协作身份" : "进入团队代码空间"}</h1>
        <p>Electron 只上传脱敏图谱；源代码仍保留在授权的本地仓库中。</p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            try {
              await saveCloudApiBase(endpoint);
              const session = register
                ? await cloudApi.register({ email, displayName, password })
                : await cloudApi.login({ email, password });
              onAuthenticated(session);
            } catch (submitError) {
              setError((submitError as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {register && (
            <input
              required
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="显示名称"
            />
          )}
          <input
            required
            type="url"
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
            placeholder="https://visionowl.example.com"
            aria-label="VisionOwl Cloud API 地址"
          />
          <input
            required
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@example.com"
          />
          <input
            required
            minLength={10}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="至少 10 位密码"
          />
          {error && <strong className="vision-cloud-form-error">{error}</strong>}
          <button type="submit" disabled={busy}>
            {busy ? <LoaderCircle size={15} className="is-spinning" /> : <LogIn size={15} />}
            {register ? "注册并登录" : "登录"}
          </button>
        </form>
        <button className="vision-cloud-auth__switch" type="button" onClick={() => setRegister((value) => !value)}>
          {register ? "已有账号，直接登录" : "第一次使用，创建账号"}
        </button>
      </section>
    </main>
  );
}

export function CloudWorkspace() {
  const [session, setSession] = useState<CloudSession | null>();
  const [projects, setProjects] = useState<CloudProject[]>([]);
  const [projectId, setProjectId] = useState<string>();
  const [graphVersion, setGraphVersion] = useState<CloudGraphVersion | null>(null);
  const [versions, setVersions] = useState<CloudGraphVersion[]>([]);
  const [documents, setDocuments] = useState<CloudDocument[]>([]);
  const [annotations, setAnnotations] = useState<CloudAnnotation[]>([]);
  const [members, setMembers] = useState<CloudProjectMember[]>([]);
  const [localProjects, setLocalProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedScope, setSelectedScope] = useState<EntityScope>();
  const [search, setSearch] = useState("");
  const [showAllDocuments, setShowAllDocuments] = useState(false);
  const [viewMode, setViewMode] = useState<CodeViewMode>("overview");
  const [dialog, setDialog] = useState<Dialog>();
  const [busy, setBusy] = useState(false);
  const [syncProgress, setSyncProgress] = useState<ProjectSyncProgress>();
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [agentContext, setAgentContext] = useState<EntityContext>();
  const [error, setError] = useState("");
  const [realtimeState, setRealtimeState] = useState<"connecting" | "connected" | "offline">("offline");
  const cursor = useRef(0);

  const graph = useMemo(() => graphFromCloud(graphVersion), [graphVersion]);
  const project = projects.find((value) => value.id === projectId);
  const canEdit = project?.role === "owner" || project?.role === "editor";
  const isOwner = project?.role === "owner";
  const boundLocalProject = localProjects.find(
    (value) => value.cloudProjectId === projectId,
  );
  const documentBindings = useMemo(() => documents.map(documentBinding), [documents]);
  const annotationBindings = useMemo(() => annotations.map(annotationBinding), [annotations]);
  const globalDocuments = documentBindings.filter(
    (document) => document.entityId === projectDocumentOwnerId(projectId || ""),
  );
  const moduleDocuments = documentBindings.filter(
    (document) => document.entityId !== projectDocumentOwnerId(projectId || ""),
  );

  const context = useMemo(() => {
    if (!projectId) return undefined;
    if (selectedScope) {
      return domainContext(projectId, graph, selectedScope, documentBindings, annotationBindings);
    }
    const entity = graph.entities.find((value) => value.id === selectedId);
    if (!entity) return undefined;
    return {
      entity,
      incoming: graph.relations.filter((relation) => relation.target === entity.id),
      outgoing: graph.relations.filter((relation) => relation.source === entity.id),
      documents: documentBindings.filter((document) => document.entityId === entity.id),
      annotations: annotationBindings.filter((annotation) => annotation.entityId === entity.id),
    } satisfies EntityContext;
  }, [annotationBindings, documentBindings, graph, projectId, selectedId, selectedScope]);

  const localAgentContext = useCallback(async () => {
    if (!boundLocalProject || !context) return undefined;
    return selectedScope
      ? visionApi.getScope(boundLocalProject.id, selectedScope)
      : visionApi.getEntity(boundLocalProject.id, context.entity.id);
  }, [boundLocalProject, context, selectedScope]);

  const syncLocalAgentDocuments = useCallback(async () => {
    if (!boundLocalProject || !projectId || !context) return;
    try {
      const localContext = await localAgentContext();
      if (!localContext) return;
      const cloudDocuments = await cloudApi.listDocuments(projectId);
      const cloudByUrl = new Map(cloudDocuments.map((document) => [document.url, document]));
      for (const document of localContext.documents) {
        const existing = cloudByUrl.get(document.url);
        if (!existing) {
          await cloudApi.createDocument(projectId, {
            scope: "module",
            stableEntityId: context.entity.id,
            provider: document.provider,
            title: document.title,
            url: document.url,
            summary: document.summary,
          });
          continue;
        }
        if (
          existing.title !== document.title ||
          existing.summary !== document.summary
        ) {
          await cloudApi.updateDocument(projectId, existing.id, {
            title: document.title,
            summary: document.summary,
          });
        }
      }
      setAgentContext(await localAgentContext());
      setDocuments(await cloudApi.listDocuments(projectId));
    } catch (documentError) {
      setError((documentError as Error).message);
    }
  }, [boundLocalProject, context, localAgentContext, projectId]);

  const loadProjects = useCallback(async () => {
    const values = await cloudApi.listProjects();
    setProjects(values);
    setProjectId((current) =>
      current && values.some((value) => value.id === current) ? current : values[0]?.id,
    );
  }, []);

  const loadSnapshot = useCallback(async () => {
    if (!projectId) {
      setGraphVersion(null);
      setDocuments([]);
      setAnnotations([]);
      setVersions([]);
      return;
    }
    const [nextGraph, nextDocuments, nextAnnotations, nextVersions] = await Promise.all([
      cloudApi.currentGraph(projectId),
      cloudApi.listDocuments(projectId),
      cloudApi.listAnnotations(projectId),
      cloudApi.listGraphVersions(projectId),
    ]);
    setGraphVersion(nextGraph);
    setDocuments(nextDocuments);
    setAnnotations(nextAnnotations);
    setVersions(nextVersions);
  }, [projectId]);

  const loadSnapshotFor = useCallback(async (targetProjectId: string) => {
    const [nextGraph, nextDocuments, nextAnnotations, nextVersions] =
      await Promise.all([
        cloudApi.currentGraph(targetProjectId),
        cloudApi.listDocuments(targetProjectId),
        cloudApi.listAnnotations(targetProjectId),
        cloudApi.listGraphVersions(targetProjectId),
      ]);
    setGraphVersion(nextGraph);
    setDocuments(nextDocuments);
    setAnnotations(nextAnnotations);
    setVersions(nextVersions);
  }, []);

  const runProjectSync = useCallback(
    async (targetProject: CloudProject, localProject: Project) => {
      setBusy(true);
      setError("");
      try {
        await analyzeAndPublish({
          cloudProject: targetProject,
          localProject,
          onProgress: setSyncProgress,
        });
        await Promise.all([
          loadSnapshotFor(targetProject.id),
          loadProjects(),
          visionApi.listProjects().then(setLocalProjects),
        ]);
        window.setTimeout(() => {
          setSyncProgress((current) =>
            current?.cloudProjectId === targetProject.id &&
            current.phase === "complete"
              ? undefined
              : current,
          );
        }, 1800);
      } catch (syncError) {
        setError((syncError as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [loadProjects, loadSnapshotFor],
  );

  const createUnifiedProject = useCallback(
    async (input: {
      name: string;
      description: string;
      defaultBranch: string;
      repoPath: string;
    }) => {
      setBusy(true);
      setError("");
      setSyncProgress({
        cloudProjectId: "creating",
        phase: "binding",
        progress: 1,
        message: "正在创建团队 Project",
      });
      let created: CloudProject | undefined;
      try {
        created = await cloudApi.createProject({
          name: input.name,
          description: input.description,
          defaultBranch: input.defaultBranch,
        });
        setProjectId(created.id);
        await loadProjects();
        const currentLocalProjects = await visionApi.listProjects();
        const localProject = await bindRepository({
          cloudProject: created,
          localProjects: currentLocalProjects,
          repoPath: input.repoPath,
          description: input.description,
          onProgress: setSyncProgress,
        });
        setLocalProjects(await visionApi.listProjects());
        setBusy(false);
        await runProjectSync(created, localProject);
      } catch (createError) {
        setSyncProgress({
          cloudProjectId: created?.id || "creating",
          phase: "failed",
          progress: 100,
          message: (createError as Error).message,
        });
        setError((createError as Error).message);
        setBusy(false);
      }
    },
    [loadProjects, runProjectSync],
  );

  const bindAndSyncProject = useCallback(
    async (input: {
      cloudProject: CloudProject;
      localProjectId?: string;
      repoPath?: string;
    }) => {
      setBusy(true);
      setError("");
      try {
        const localProject = input.localProjectId
          ? await visionApi.bindCloudProject(
              input.localProjectId,
              input.cloudProject.id,
            )
          : await bindRepository({
              cloudProject: input.cloudProject,
              localProjects,
              repoPath: input.repoPath || "",
              description: input.cloudProject.description,
              onProgress: setSyncProgress,
            });
        setLocalProjects(await visionApi.listProjects());
        setBusy(false);
        await runProjectSync(input.cloudProject, localProject);
      } catch (bindError) {
        setSyncProgress({
          cloudProjectId: input.cloudProject.id,
          localProjectId: input.localProjectId,
          phase: "failed",
          progress: 100,
          message: (bindError as Error).message,
        });
        setError((bindError as Error).message);
        setBusy(false);
      }
    },
    [localProjects, runProjectSync],
  );

  useEffect(() => {
    void cloudApi.session().then(setSession).catch(() => setSession(null));
  }, []);

  useEffect(() => {
    if (!session) return;
    void Promise.all([loadProjects(), visionApi.listProjects().then(setLocalProjects)]).catch(
      (loadError) => setError((loadError as Error).message),
    );
  }, [loadProjects, session]);

  useEffect(() => {
    setSelectedId(undefined);
    setSelectedScope(undefined);
    setShowAllDocuments(false);
    cursor.current = 0;
    void loadSnapshot().catch((loadError) => setError((loadError as Error).message));
    if (!projectId || !session) return;
    return connectProjectRealtime({
      projectId,
      after: cursor.current,
      onState: setRealtimeState,
      onEvent: (event) => {
        cursor.current = Math.max(cursor.current, event.sequence);
        if (event.type === "graph.version.activated") {
          void Promise.all([loadSnapshot(), loadProjects()]);
        } else if (event.type.startsWith("document.")) {
          void cloudApi.listDocuments(projectId).then(setDocuments);
        } else if (event.type.startsWith("annotation.")) {
          void cloudApi.listAnnotations(projectId).then(setAnnotations);
        } else if (event.type.startsWith("project.member.")) {
          void cloudApi.listMembers(projectId).then(setMembers);
        }
      },
    });
  }, [loadProjects, loadSnapshot, projectId, session]);

  useEffect(() => {
    let cancelled = false;
    if (!boundLocalProject || !context) {
      setAgentContext(undefined);
      return;
    }
    void (async () => {
      try {
        let localContext = await localAgentContext();
        if (!localContext || cancelled) return;
        const localUrls = new Set(localContext.documents.map((document) => document.url));
        const missing = context.documents.filter(
          (document) => !localUrls.has(document.url),
        );
        for (const document of missing) {
          await visionApi.addDocument(boundLocalProject.id, context.entity.id, {
            provider: document.provider,
            title: document.title,
            url: document.url,
            summary: document.summary,
          });
        }
        if (missing.length > 0) localContext = await localAgentContext();
        if (!cancelled) setAgentContext(localContext);
      } catch (agentError) {
        if (!cancelled) {
          setAgentContext(undefined);
          setError((agentError as Error).message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [boundLocalProject, context, localAgentContext]);

  const interactionPath = useMemo(
    () => buildInteractionPath(graph.relations, selectedId),
    [graph.relations, selectedId],
  );

  if (session === undefined) {
    return (
      <main className="vision-cloud-loading">
        <LoaderCircle size={24} className="is-spinning" />
        <span>正在恢复加密云端会话</span>
      </main>
    );
  }
  if (!session) return <CloudAuth onAuthenticated={setSession} />;

  return (
    <main className="monitor-app vision-code-app vision-cloud-app">
      <header className="app-header">
        <div className="brand">
          <img src="/hackowl.png" alt="" />
          <div>
            <strong>VisionOwl Cloud</strong>
            <span>团队共享代码知识空间</span>
          </div>
        </div>
        <div className="header-status">
          <CodeModeSwitch value={viewMode} onChange={setViewMode} />
          <select
            className="vision-project-select"
            value={projectId || ""}
            onChange={(event) => setProjectId(event.target.value || undefined)}
          >
            {projects.length === 0 && <option value="">尚未加入 Project</option>}
            {projects.map((value) => (
              <option key={value.id} value={value.id}>{value.name} · {value.role}</option>
            ))}
          </select>
          <button className="vision-header-command" type="button" onClick={() => setDialog("create")}>
            <Plus size={14} />创建
          </button>
          <button className="vision-header-command" type="button" onClick={() => setDialog("join")}>
            <KeyRound size={14} />加入
          </button>
          {isOwner && projectId && (
            <>
              <button
                className="vision-header-command"
                type="button"
                disabled={busy}
                onClick={() => {
                  if (!project) return;
                  if (boundLocalProject) {
                    void runProjectSync(project, boundLocalProject);
                  } else {
                    setDialog("sync");
                  }
                }}
              >
                <RefreshCw size={14} />
                {boundLocalProject ? "重新分析并同步" : "绑定仓库"}
              </button>
              <button className="vision-header-command" type="button" onClick={() => setDialog("invite")}>
                <Users size={14} />邀请
              </button>
            </>
          )}
          {projectId && (
            <button
              className="vision-cloud-icon-button"
              type="button"
              title="版本历史"
              onClick={() => setDialog("versions")}
            >
              <GitBranch size={14} />
            </button>
          )}
          <span className={`feed-status is-${realtimeState}`}>
            {realtimeState === "connected" ? <Wifi size={14} /> : <WifiOff size={14} />}
            {realtimeState === "connected" ? "CLOUD LIVE" : "CLOUD OFFLINE"}
          </span>
          <button
            className="vision-cloud-icon-button"
            type="button"
            title={`退出 ${session.user.email}`}
            onClick={() => void cloudApi.logout().finally(() => setSession(null))}
          >
            <LogOut size={14} />
          </button>
        </div>
      </header>

      <section className="vision-code-metrics">
        <div><span>MODULES</span><strong>{graph.entities.length}</strong><small>共享架构实体</small></div>
        <div><span>RELATIONS</span><strong>{graph.relations.length}</strong><small>源码验证关系</small></div>
        <div><span>ROLE</span><strong>{project?.role?.toUpperCase() || "--"}</strong><small>{session.user.displayName}</small></div>
        <div><span>VERSION</span><strong>{graph.commit || "--"}</strong><small>{graph.branch || "尚未发布"}</small></div>
      </section>

      <section
        className={`vision-cloud-workspace ${
          chatCollapsed ? "is-chat-collapsed" : ""
        }`}
      >
        <div className={`vision-code-canvas ${projectId ? "has-document-shelf" : ""}`}>
          <div className="canvas-heading vision-code-heading">
            <div>
              <span>CLOUD GRAPH · {project?.role?.toUpperCase() || "NO PROJECT"}</span>
              <strong>{project?.name || "创建或加入团队 Project"}</strong>
            </div>
            <div className="vision-code-tools">
              <label>
                <Search size={14} />
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索共享模块" />
              </label>
              <button type="button" disabled={!projectId || busy} onClick={() => void loadSnapshot()}>
                <RefreshCw size={14} />刷新
              </button>
              {isOwner && projectId && (
                <button type="button" onClick={() => {
                  void cloudApi.listMembers(projectId).then(setMembers);
                  setDialog("members");
                }}>
                  <ShieldCheck size={14} />成员
                </button>
              )}
            </div>
          </div>

          {syncProgress && <CloudSyncProgress value={syncProgress} />}

          {projectId && (
            <GlobalDocumentShelf
              projectId={projectId}
              documents={globalDocuments}
              moduleDocumentCount={moduleDocuments.length}
              showAllDocuments={showAllDocuments}
              onToggleAll={() => setShowAllDocuments((value) => !value)}
              canEdit={Boolean(canEdit)}
              onAddDocument={(input) =>
                cloudApi.createDocument(projectId, { ...input, scope: "global" })
              }
              onChanged={() => void cloudApi.listDocuments(projectId).then(setDocuments)}
            />
          )}

          {graph.entities.length > 0 ? (
            <CodeGraph
              entities={graph.entities}
              relations={graph.relations}
              selectedId={selectedId}
              selectedDomainId={selectedScope?.id}
              context={context}
              documents={moduleDocuments}
              showAllDocuments={showAllDocuments}
              search={search}
              mode={viewMode}
              interactionPath={interactionPath}
              simulationStep={-1}
              onSelect={(entityId) => {
                setSelectedScope(undefined);
                setSelectedId((current) => (current === entityId ? undefined : entityId));
              }}
              onSelectDomain={(domain) => {
                setSelectedId(undefined);
                setSelectedScope((current) => current?.id === domain?.id ? undefined : domain ? domainScope(domain) : undefined);
              }}
              onClearSelection={() => {
                setSelectedId(undefined);
                setSelectedScope(undefined);
              }}
            />
          ) : (
            <div className="vision-graph-empty">
              <Cloud size={28} />
              <strong>{projectId ? "该 Project 尚无团队图谱" : "还没有团队 Project"}</strong>
              <small>
                {isOwner
                  ? syncProgress
                    ? "本地 Agent 正在分析并同步脱敏图谱"
                    : "绑定本地仓库后，系统会自动分析并同步"
                  : "等待 Owner 完成首次代码分析"}
              </small>
            </div>
          )}
        </div>

        <CodeChat
          projectId={boundLocalProject?.id}
          entity={context?.entity}
          scope={selectedScope}
          documents={agentContext?.documents ?? []}
          collapsed={chatCollapsed}
          onToggle={() => setChatCollapsed((current) => !current)}
          onDocumentCreated={() => void syncLocalAgentDocuments()}
          documentActionsEnabled={Boolean(boundLocalProject)}
          unavailableReason={
            projectId && !boundLocalProject
              ? isOwner
                ? "先绑定本地仓库以启用 Agent"
                : "当前设备没有该 Project 的源码上下文"
              : undefined
          }
        />

        <CodeInspector
          projectId={projectId}
          context={context}
          canEdit={Boolean(canEdit)}
          currentAuthor={session.user.displayName}
          onClose={() => {
            setSelectedId(undefined);
            setSelectedScope(undefined);
          }}
          onAddDocument={(entityId, input) =>
            cloudApi.createDocument(projectId!, {
              ...input,
              scope: "module",
              stableEntityId: entityId,
            })
          }
          onAddAnnotation={(entityId, body) =>
            cloudApi.createAnnotation(projectId!, entityId, body)
          }
          onChanged={() => void loadSnapshot()}
        />
      </section>

      {error && (
        <div className="vision-toast is-error">
          <span>{error}</span>
          <button type="button" onClick={() => setError("")}><X size={14} /></button>
        </div>
      )}

      {dialog && (
        <CloudDialog
          dialog={dialog}
          project={project}
          localProjects={localProjects}
          versions={versions}
          members={members}
          busy={busy}
          setBusy={setBusy}
          onClose={() => setDialog(undefined)}
          onError={setError}
          onSnapshotChanged={loadSnapshot}
          onCreateProject={(input) => void createUnifiedProject(input)}
          onSyncProject={(input) => void bindAndSyncProject(input)}
          onJoined={(joinedProject) => {
            void loadProjects().then(() => setProjectId(joinedProject.id));
          }}
          onMembersChanged={() =>
            projectId ? void cloudApi.listMembers(projectId).then(setMembers) : undefined
          }
        />
      )}
    </main>
  );
}

function CloudSyncProgress({ value }: { value: ProjectSyncProgress }) {
  const phaseLabel = {
    binding: "绑定仓库",
    analyzing: "分析代码",
    sanitizing: "图谱脱敏",
    uploading: "上传版本",
    activating: "激活图谱",
    complete: "同步完成",
    failed: "同步失败",
  }[value.phase];
  return (
    <aside
      className={`vision-cloud-sync-progress is-${value.phase}`}
      aria-live="polite"
    >
      <span className="vision-cloud-sync-progress__icon">
        {value.phase === "analyzing" ||
        value.phase === "uploading" ||
        value.phase === "activating" ? (
          <LoaderCircle size={16} className="is-spinning" />
        ) : (
          <FolderCode size={16} />
        )}
      </span>
      <span className="vision-cloud-sync-progress__copy">
        <small>LOCAL AGENT → TEAM PROJECT · {phaseLabel}</small>
        <strong>{value.message}</strong>
      </span>
      <strong className="vision-cloud-sync-progress__percent">
        {value.progress}%
      </strong>
      <span className="vision-cloud-sync-progress__track">
        <i style={{ width: `${Math.max(2, value.progress)}%` }} />
      </span>
    </aside>
  );
}

function CloudDialog({
  dialog,
  project,
  localProjects,
  versions,
  members,
  busy,
  setBusy,
  onClose,
  onError,
  onSnapshotChanged,
  onCreateProject,
  onSyncProject,
  onJoined,
  onMembersChanged,
}: {
  dialog: Dialog;
  project?: CloudProject;
  localProjects: Project[];
  versions: CloudGraphVersion[];
  members: CloudProjectMember[];
  busy: boolean;
  setBusy: (value: boolean) => void;
  onClose: () => void;
  onError: (message: string) => void;
  onSnapshotChanged: () => Promise<void>;
  onCreateProject: (input: {
    name: string;
    description: string;
    defaultBranch: string;
    repoPath: string;
  }) => void;
  onSyncProject: (input: {
    cloudProject: CloudProject;
    localProjectId?: string;
    repoPath?: string;
  }) => void;
  onJoined: (project: CloudProject) => void;
  onMembersChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("master");
  const [inviteToken, setInviteToken] = useState("");
  const [inviteRole, setInviteRole] = useState<"editor" | "viewer">("viewer");
  const [generatedInvite, setGeneratedInvite] = useState("");
  const [invites, setInvites] = useState<CloudProjectInvite[]>([]);
  const availableLocalProject = localProjects.find(
    (value) => !value.cloudProjectId || value.cloudProjectId === project?.id,
  );
  const [localProjectId, setLocalProjectId] = useState(
    availableLocalProject?.id || "__new__",
  );
  const [repoPath, setRepoPath] = useState(availableLocalProject?.repoPath || "");
  const title = {
    create: "创建团队 Project",
    join: "使用邀请码加入",
    invite: "邀请团队成员",
    sync: "绑定仓库并同步",
    versions: "图谱版本",
    members: "Project 成员",
  }[dialog];

  useEffect(() => {
    if (dialog === "invite" && project) {
      void cloudApi
        .listInvites(project.id)
        .then(setInvites)
        .catch((error) => onError((error as Error).message));
    }
  }, [dialog, onError, project]);

  const perform = async (work: () => Promise<void>) => {
    setBusy(true);
    onError("");
    try {
      await work();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="vision-modal-backdrop" role="presentation">
      <section className="vision-cloud-dialog" role="dialog" aria-modal="true">
        <header>
          <span><Cloud size={15} />{title}</span>
          <button type="button" onClick={onClose}><X size={15} /></button>
        </header>

        {dialog === "create" && (
          <form onSubmit={(event) => {
            event.preventDefault();
            onClose();
            onCreateProject({
              name,
              description,
              defaultBranch,
              repoPath,
            });
          }}>
            <label>
              Project 名称
              <input required value={name} onChange={(event) => setName(event.target.value)} placeholder="My Project" />
            </label>
            <label>
              本地代码仓库
              <div className="vision-path-input">
                <FolderCode size={15} />
                <input required value={repoPath} onChange={(event) => setRepoPath(event.target.value)} placeholder="/Users/name/workspace/project" />
                {window.visionOwlDesktop && (
                  <button type="button" onClick={async () => {
                    const selected = await window.visionOwlDesktop?.selectDirectory();
                    if (!selected) return;
                    setRepoPath(selected);
                    if (!name) setName(selected.split(/[\\/]/).filter(Boolean).at(-1) || "");
                  }}>选择</button>
                )}
              </div>
            </label>
            <label>
              Project 描述
              <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="项目负责的业务与代码边界" />
            </label>
            <label>
              默认分支
              <input required value={defaultBranch} onChange={(event) => setDefaultBranch(event.target.value)} placeholder="master" />
            </label>
            <p>源码仅由本机 Agent 读取；创建后会自动分析、脱敏并发布首个团队图谱。</p>
            <button type="submit" disabled={busy}>创建、分析并同步</button>
          </form>
        )}

        {dialog === "join" && (
          <form onSubmit={(event) => {
            event.preventDefault();
            void perform(async () => {
              const result = await cloudApi.redeemInvite(inviteToken);
              onJoined(result.project);
              onClose();
            });
          }}>
            <input required value={inviteToken} onChange={(event) => setInviteToken(event.target.value)} placeholder="vwo_..." />
            <p>邀请码只用于加入 Project，兑换后由账号身份和角色权限继续访问。</p>
            <button type="submit" disabled={busy}>兑换邀请码</button>
          </form>
        )}

        {dialog === "invite" && project && (
          <div className="vision-cloud-dialog-stack">
            <form onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                const invite = await cloudApi.createInvite(project.id, { role: inviteRole });
                setGeneratedInvite(invite.token || "");
                setInvites(await cloudApi.listInvites(project.id));
              });
            }}>
              <select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as "editor" | "viewer")}>
                <option value="viewer">Viewer · 只读</option>
                <option value="editor">Editor · 文档与批注</option>
              </select>
              {generatedInvite && (
                <div className="vision-cloud-invite-token">
                  <code>{generatedInvite}</code>
                  <button type="button" onClick={() => void navigator.clipboard.writeText(generatedInvite)}><Copy size={14} /></button>
                </div>
              )}
              <button type="submit" disabled={busy}>生成一次性邀请码</button>
            </form>
            <div className="vision-cloud-list">
              {invites.map((invite) => (
                <article key={invite.id}>
                  <span>
                    <strong>{invite.role.toUpperCase()}</strong>
                    <small>使用 {invite.useCount}/{invite.maxUses} · {invite.revokedAt ? "已撤销" : "有效"}</small>
                  </span>
                  <time>{new Date(invite.expiresAt).toLocaleDateString("zh-CN")}</time>
                  {!invite.revokedAt && (
                    <button type="button" title="撤销邀请" onClick={() => void perform(async () => {
                      await cloudApi.revokeInvite(project.id, invite.id);
                      setInvites(await cloudApi.listInvites(project.id));
                    })}><Trash2 size={13} /></button>
                  )}
                </article>
              ))}
            </div>
          </div>
        )}

        {dialog === "sync" && project && (
          <form onSubmit={(event) => {
            event.preventDefault();
            onClose();
            onSyncProject({
              cloudProject: project,
              localProjectId:
                localProjectId === "__new__" ? undefined : localProjectId,
              repoPath: localProjectId === "__new__" ? repoPath : undefined,
            });
          }}>
            <label>
              本地代码仓库
              <select required value={localProjectId} onChange={(event) => {
                const next = event.target.value;
                setLocalProjectId(next);
                const local = localProjects.find((value) => value.id === next);
                if (local) setRepoPath(local.repoPath);
              }}>
                {localProjects
                  .filter((value) => !value.cloudProjectId || value.cloudProjectId === project.id)
                  .map((value) => (
                    <option key={value.id} value={value.id}>
                      {value.name} · {value.branch || "unknown"}
                    </option>
                  ))}
                <option value="__new__">选择新的本地仓库</option>
              </select>
            </label>
            {localProjectId === "__new__" && (
              <label>
                仓库绝对路径
                <div className="vision-path-input">
                  <FolderCode size={15} />
                  <input required value={repoPath} onChange={(event) => setRepoPath(event.target.value)} placeholder="/Users/name/workspace/project" />
                  {window.visionOwlDesktop && (
                    <button type="button" onClick={async () => {
                      const selected = await window.visionOwlDesktop?.selectDirectory();
                      if (selected) setRepoPath(selected);
                    }}>选择</button>
                  )}
                </div>
              </label>
            )}
            <p>绑定仅保存在当前设备。分析完成后只上传脱敏图谱，不上传源码。</p>
            <button type="submit" disabled={busy || (localProjectId === "__new__" && !repoPath)}>
              绑定、分析并同步
            </button>
          </form>
        )}

        {dialog === "versions" && project && (
          <div className="vision-cloud-list">
            {versions.map((version) => (
              <article key={version.id}>
                <span><strong>{version.commit.slice(0, 10)}</strong><small>{version.branch} · {version.status}</small></span>
                <time>{new Date(version.createdAt).toLocaleString("zh-CN")}</time>
                {project.role === "owner" && version.status !== "active" && (
                  <button type="button" disabled={busy} onClick={() => void perform(async () => {
                    await cloudApi.activateGraph(project.id, version.id);
                    await onSnapshotChanged();
                  })}>激活</button>
                )}
              </article>
            ))}
            {versions.length === 0 && <p>尚无图谱版本。</p>}
          </div>
        )}

        {dialog === "members" && project && (
          <div className="vision-cloud-list">
            <button type="button" className="vision-cloud-list__refresh" onClick={onMembersChanged}>刷新成员</button>
            {members.map((member) => (
              <article key={member.userId}>
                <span><strong>{member.displayName}</strong><small>{member.email}</small></span>
                {member.role === "owner" ? (
                  <code>owner</code>
                ) : (
                  <select value={member.role} disabled={busy} onChange={(event) => void perform(async () => {
                    await cloudApi.updateMember(
                      project.id,
                      member.userId,
                      event.target.value as "editor" | "viewer",
                    );
                    onMembersChanged();
                  })}>
                    <option value="editor">editor</option>
                    <option value="viewer">viewer</option>
                  </select>
                )}
                {member.role !== "owner" && (
                  <button type="button" title="移除成员" disabled={busy} onClick={() => void perform(async () => {
                    await cloudApi.removeMember(project.id, member.userId);
                    onMembersChanged();
                  })}><Trash2 size={13} /></button>
                )}
              </article>
            ))}
            {members.length === 0 && <p>点击刷新加载成员。</p>}
          </div>
        )}
      </section>
    </div>
  );
}
