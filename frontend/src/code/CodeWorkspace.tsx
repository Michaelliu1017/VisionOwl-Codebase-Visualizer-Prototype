import {
  FolderCode,
  GitBranch,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Route,
  Search,
  Sparkles,
  Wifi,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AnalysisEvent,
  AnalysisJob,
  DocumentBinding,
  EntityContext,
  EntityScope,
  GraphVersion,
  Project,
} from "@visionowl/contracts";
import { projectDocumentOwnerId } from "@visionowl/contracts";
import { AnalysisProgress } from "./AnalysisProgress";
import { CodeChat } from "./CodeChat";
import { CodeGraph } from "./CodeGraph";
import { CodeInspector } from "./CodeInspector";
import { GlobalDocumentShelf } from "./GlobalDocumentShelf";
import type { CodeDomainLayout } from "./layout";
import {
  CodeModeSwitch,
  type CodeViewMode,
} from "./CodeModeSwitch";
import { visionApi } from "./api";
import { buildInteractionPath } from "./interaction-path";

const emptyGraph: GraphVersion = {
  id: "",
  projectId: "",
  source: "scanner",
  createdAt: "",
  entities: [],
  relations: [],
};

function scopeFromDomain(domain: CodeDomainLayout): EntityScope {
  return {
    id: domain.id,
    name: domain.label,
    path: domain.key,
    summary: `${domain.label} 领域包含 ${domain.entityIds.length} 个源码节点；分析时聚合内部关系、跨领域上下游、文档与批注。`,
    entityIds: domain.entityIds,
  };
}

export function CodeWorkspace() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string>();
  const [graph, setGraph] = useState<GraphVersion>(emptyGraph);
  const [jobs, setJobs] = useState<AnalysisJob[]>([]);
  const [analysisEvents, setAnalysisEvents] = useState<AnalysisEvent[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedScope, setSelectedScope] = useState<EntityScope>();
  const [context, setContext] = useState<EntityContext>();
  const [documents, setDocuments] = useState<DocumentBinding[]>([]);
  const [showAllDocuments, setShowAllDocuments] = useState(false);
  const [search, setSearch] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [repoName, setRepoName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [repoDescription, setRepoDescription] = useState("");
  const [viewMode, setViewMode] = useState<CodeViewMode>("overview");
  const [activeFlowId, setActiveFlowId] = useState("overview");
  const [simulationRun, setSimulationRun] = useState(0);
  const [simulationStep, setSimulationStep] = useState(-1);
  const [simulationPlaying, setSimulationPlaying] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadProjects = useCallback(async () => {
    const values = await visionApi.listProjects();
    setProjects(values);
    setProjectId((current) =>
      current && values.some((project) => project.id === current)
        ? current
        : values[0]?.id,
    );
  }, []);

  const loadProject = useCallback(async () => {
    if (!projectId) {
      setGraph(emptyGraph);
      setJobs([]);
      setDocuments([]);
      return;
    }
    const [graphValue, jobValues, documentValues] = await Promise.all([
      visionApi.getGraph(projectId),
      visionApi.listJobs(projectId),
      visionApi.listDocuments(projectId),
    ]);
    setGraph(graphValue);
    setJobs(jobValues);
    setDocuments(documentValues);
  }, [projectId]);

  const loadDocuments = useCallback(async () => {
    if (!projectId) {
      setDocuments([]);
      return;
    }
    setDocuments(await visionApi.listDocuments(projectId));
  }, [projectId]);

  const latestJob = jobs[0];
  const analysisRunning = latestJob?.status === "running";

  useEffect(() => {
    void loadProjects().catch((loadError) => setError(loadError.message));
  }, [loadProjects]);

  useEffect(() => {
    setSelectedId(undefined);
    setSelectedScope(undefined);
    setContext(undefined);
    setAnalysisEvents([]);
    setActiveFlowId("overview");
    setShowAllDocuments(false);
    void loadProject().catch((loadError) => setError(loadError.message));
  }, [loadProject, projectId]);

  useEffect(() => {
    if (!projectId || !analysisRunning) return;
    const source = visionApi.events(projectId);
    source.addEventListener("analysis", (raw) => {
      const event = JSON.parse((raw as MessageEvent<string>).data) as AnalysisEvent;
      setAnalysisEvents((current) =>
        current.some((item) => item.id === event.id)
          ? current
          : [...current, event].slice(-120),
      );
      setJobs((current) =>
        current.map((job) =>
          job.id === event.jobId &&
          job.status === "running" &&
          Date.parse(event.createdAt) >= Date.parse(job.updatedAt)
            ? {
                ...job,
                phase: event.phase,
                progress: event.progress,
                message: event.message,
                status:
                  event.phase === "completed"
                    ? "completed"
                    : event.phase === "failed"
                      ? "failed"
                      : "running",
                updatedAt: event.createdAt,
              }
            : job,
        ),
      );
      if (
        event.phase === "facts_ready" ||
        event.phase === "architecture_ready" ||
        (event.phase === "enriching" && event.progress === 52)
      ) {
        void visionApi
          .getGraph(projectId)
          .then((value) => setGraph(value))
          .catch((loadError) => setError(loadError.message));
      }
      if (event.phase === "completed" || event.phase === "failed") {
        void Promise.all([loadProject(), loadProjects()]);
      }
    });
    return () => source.close();
  }, [analysisRunning, loadProject, loadProjects, projectId]);

  useEffect(() => {
    const flows = graph.executionFlows ?? [];
    if (flows.length === 0) {
      setActiveFlowId("overview");
      return;
    }
    setActiveFlowId((current) =>
      current !== "overview" && flows.some((flow) => flow.id === current)
        ? current
        : (flows.find((flow) => flow.featured)?.id ?? "overview"),
    );
  }, [graph.executionFlows, graph.id]);

  const loadContext = useCallback(
    async () => {
      if (!projectId || (!selectedId && !selectedScope)) {
        setContext(undefined);
        return;
      }
      setContext(
        selectedScope
          ? await visionApi.getScope(projectId, selectedScope)
          : await visionApi.getEntity(projectId, selectedId!),
      );
    },
    [projectId, selectedId, selectedScope],
  );

  useEffect(() => {
    void loadContext().catch((loadError) => {
      setContext(undefined);
      setError((loadError as Error).message);
    });
  }, [loadContext]);

  const selectedEntity =
    context?.entity ??
    graph.entities.find((entity) => entity.id === selectedId);
  const project = projects.find((item) => item.id === projectId);
  const globalDocumentOwner = projectId
    ? projectDocumentOwnerId(projectId)
    : "";
  const globalDocuments = useMemo(
    () =>
      documents.filter(
        (document) => document.entityId === globalDocumentOwner,
      ),
    [documents, globalDocumentOwner],
  );
  const moduleDocuments = useMemo(
    () =>
      documents.filter(
        (document) => document.entityId !== globalDocumentOwner,
      ),
    [documents, globalDocumentOwner],
  );
  const executionFlows = graph.executionFlows ?? [];
  const activeFlow = executionFlows.find((flow) => flow.id === activeFlowId);
  const architectureEntities = useMemo(
    () =>
      graph.entities.filter((entity) => entity.metadata.execution !== true),
    [graph.entities],
  );
  const architectureRelations = useMemo(
    () =>
      graph.relations.filter(
        (relation) => relation.metadata.execution !== true,
      ),
    [graph.relations],
  );
  const visibleEntities = useMemo(() => {
    if (!activeFlow) return architectureEntities;
    const ids = new Set(activeFlow.entityIds);
    return graph.entities.filter((entity) => ids.has(entity.id));
  }, [activeFlow, architectureEntities, graph.entities]);
  const visibleRelations = useMemo(() => {
    if (!activeFlow) return architectureRelations;
    const ids = new Set(activeFlow.relationIds);
    return graph.relations.filter((relation) => ids.has(relation.id));
  }, [activeFlow, architectureRelations, graph.relations]);
  const currentAnalysisEvents = useMemo(
    () =>
      latestJob
        ? analysisEvents.filter((event) => event.jobId === latestJob.id)
        : [],
    [analysisEvents, latestJob],
  );
  const currentAnalysisEvent =
    latestJob?.status === "running" ? currentAnalysisEvents.at(-1) : undefined;
  const moduleCount = architectureEntities.filter(
    (entity) => entity.kind === "module",
  ).length;
  const evidenceCount = useMemo(
    () =>
      visibleEntities.reduce(
        (count, entity) => count + entity.evidence.length,
        0,
      ) +
      visibleRelations.reduce(
        (count, relation) => count + relation.evidence.length,
        0,
      ),
    [visibleEntities, visibleRelations],
  );
  const interactionPath = useMemo(
    () => buildInteractionPath(visibleRelations, selectedId),
    [selectedId, visibleRelations],
  );
  const activeInteraction =
    simulationStep >= 0 && simulationStep < interactionPath.length
      ? interactionPath[simulationStep]
      : undefined;
  const activeEvidence = activeInteraction?.evidence[0];

  useEffect(() => {
    if (
      viewMode !== "simulation" ||
      !selectedId ||
      interactionPath.length === 0
    ) {
      setSimulationStep(-1);
      setSimulationPlaying(false);
      return;
    }

    let currentStep = 0;
    const stepDuration = Math.min(
      900,
      Math.max(280, Math.floor(3200 / interactionPath.length)),
    );
    setSimulationStep(0);
    setSimulationPlaying(true);
    const timer = window.setInterval(() => {
      currentStep += 1;
      if (currentStep >= interactionPath.length) {
        window.clearInterval(timer);
        setSimulationStep(interactionPath.length);
        setSimulationPlaying(false);
        return;
      }
      setSimulationStep(currentStep);
    }, stepDuration);
    return () => window.clearInterval(timer);
  }, [interactionPath, selectedId, simulationRun, viewMode]);

  const selectEntity = useCallback(
    (entityId?: string) => {
      setSelectedScope(undefined);
      if (!entityId) {
        setSelectedId(undefined);
        return;
      }
      if (viewMode === "simulation") {
        if (entityId === selectedId) {
          setSimulationRun((current) => current + 1);
        } else {
          setSelectedId(entityId);
        }
        return;
      }
      setSelectedId((current) => (current === entityId ? undefined : entityId));
    },
    [selectedId, viewMode],
  );
  const selectDomain = useCallback((domain?: CodeDomainLayout) => {
    setSelectedId(undefined);
    if (!domain) {
      setSelectedScope(undefined);
      return;
    }
    setSelectedScope((current) =>
      current?.id === domain.id ? undefined : scopeFromDomain(domain),
    );
  }, []);
  const clearSelection = useCallback(() => {
    setSelectedId(undefined);
    setSelectedScope(undefined);
  }, []);

  const modeLabel = activeFlow
    ? "SOURCE-BACKED EXECUTION FLOW"
    : {
        overview: "CODE SYSTEM OVERVIEW",
        focus: "MODULE FOCUS",
        simulation: "EVIDENCE PATH SIMULATION",
      }[viewMode];

  return (
    <main className="monitor-app vision-code-app">
      <header className="app-header">
        <div className="brand">
          <img src="/hackowl.png" alt="" />
          <div>
            <strong>VisionOwl</strong>
            <span>本地代码知识与交互推演</span>
          </div>
        </div>

        <div className="header-status">
          <CodeModeSwitch
            value={viewMode}
            onChange={(mode) => {
              setViewMode(mode);
              if (mode === "simulation" && selectedId) {
                setSimulationRun((current) => current + 1);
              }
            }}
          />
          <select
            className="vision-project-select"
            value={projectId ?? ""}
            onChange={(event) => setProjectId(event.target.value || undefined)}
            aria-label="选择项目"
          >
            {projects.length === 0 && <option value="">尚未导入项目</option>}
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <button
            className="vision-header-command"
            type="button"
            onClick={() => setImportOpen(true)}
          >
            <Plus size={14} />
            导入仓库
          </button>
          <span className="feed-status">
            <Wifi size={14} />
            LOCAL ENGINE
          </span>
        </div>
      </header>

      <section className="vision-code-metrics">
        <div>
          <span>{activeFlow ? "STEPS" : "MODULES"}</span>
          <strong>{activeFlow ? visibleEntities.length : moduleCount}</strong>
          <small>{activeFlow ? "执行节点" : "代码模块"}</small>
        </div>
        <div>
          <span>RELATIONS</span>
          <strong>{visibleRelations.length}</strong>
          <small>{activeFlow ? "有向执行步骤" : "依赖与包含关系"}</small>
        </div>
        <div>
          <span>EVIDENCE</span>
          <strong>{evidenceCount}</strong>
          <small>源码证据</small>
        </div>
        <div>
          <span>VERSION</span>
          <strong>{graph.commit ?? "--"}</strong>
          <small>{graph.branch ?? "未识别 Git 分支"}</small>
        </div>
      </section>

      <section
        className={`vision-code-workspace ${
          chatCollapsed ? "is-chat-collapsed" : ""
        }`}
      >
        <div
          className={`vision-code-canvas ${
            executionFlows.length > 0 ? "has-execution-flows" : ""
          } ${projectId ? "has-document-shelf" : ""}`}
        >
          <div className="canvas-heading vision-code-heading">
            <div>
              <span>{modeLabel}</span>
              <strong>
                {activeFlow?.name ??
                  project?.name ??
                  "选择或导入本地仓库"}
              </strong>
            </div>
            <div className="vision-code-tools">
              <label>
                <Search size={14} />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="搜索模块或路径"
                />
              </label>
              <button
                type="button"
                disabled={!projectId || analysisRunning}
                onClick={async () => {
                  if (!projectId) return;
                  setBusy(true);
                  setError("");
                  try {
                    const job = await visionApi.analyze(projectId, true);
                    setAnalysisEvents([]);
                    setJobs((current) => [job, ...current]);
                  } catch (analysisError) {
                    setError((analysisError as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {analysisRunning || busy ? (
                  <LoaderCircle size={14} className="is-spinning" />
                ) : (
                  <RefreshCw size={14} />
                )}
                {analysisRunning ? "分析中" : "重新分析"}
              </button>
            </div>
          </div>

          {executionFlows.length > 0 && (
            <div className="vision-execution-flow-bar">
              <nav aria-label="选择代码执行链路">
                <button
                  type="button"
                  className={activeFlowId === "overview" ? "is-active" : ""}
                  onClick={() => {
                    setActiveFlowId("overview");
                    clearSelection();
                  }}
                >
                  架构总览
                </button>
                {executionFlows.map((flow) => (
                  <button
                    key={flow.id}
                    type="button"
                    className={activeFlowId === flow.id ? "is-active" : ""}
                    onClick={() => {
                      setActiveFlowId(flow.id);
                      clearSelection();
                      setViewMode("overview");
                    }}
                  >
                    {flow.name}
                  </button>
                ))}
              </nav>
              <div>
                <Route size={14} />
                <span>
                  <strong>
                    {activeFlow
                      ? activeFlow.summary
                      : "模块级静态架构；选择一条执行流查看函数、队列与数据存储的真实调用顺序。"}
                  </strong>
                  <small>
                    {activeFlow
                      ? `入口：${activeFlow.entryPoint}`
                      : `${executionFlows.length} 条源码验证执行流`}
                  </small>
                </span>
              </div>
            </div>
          )}

          {projectId && (
            <GlobalDocumentShelf
              projectId={projectId}
              documents={globalDocuments}
              moduleDocumentCount={moduleDocuments.length}
              showAllDocuments={showAllDocuments}
              onToggleAll={() =>
                setShowAllDocuments((current) => !current)
              }
              onChanged={() => void loadDocuments()}
            />
          )}

          {visibleEntities.length > 0 ? (
            <CodeGraph
              entities={visibleEntities}
              relations={visibleRelations}
              selectedId={selectedId}
              selectedDomainId={selectedScope?.id}
              context={context}
              documents={moduleDocuments}
              showAllDocuments={showAllDocuments}
              search={search}
              mode={viewMode}
              interactionPath={interactionPath}
              simulationStep={simulationStep}
              executionFlowId={activeFlow?.id}
              onSelect={selectEntity}
              onSelectDomain={selectDomain}
              onClearSelection={clearSelection}
            />
          ) : (
            <div className={`vision-graph-empty ${analysisRunning ? "is-analyzing" : ""}`}>
              {analysisRunning ? (
                <>
                  <LoaderCircle size={28} className="is-spinning" />
                  <strong>
                    {currentAnalysisEvent?.message ?? latestJob?.message ?? "正在准备分析"}
                  </strong>
                  <small>Understand-Anything 正在生成知识图谱</small>
                </>
              ) : (
                <>
                  <FolderCode size={28} />
                  <strong>{project ? "该项目尚未生成图谱" : "尚未导入代码仓库"}</strong>
                  <button
                    type="button"
                    onClick={() =>
                      projectId
                        ? void visionApi.analyze(projectId, true).then((job) => {
                            setAnalysisEvents([]);
                            setJobs((current) => [job, ...current]);
                          })
                        : setImportOpen(true)
                    }
                  >
                    <Sparkles size={15} />
                    {project ? "开始分析" : "导入仓库"}
                  </button>
                </>
              )}
            </div>
          )}

          {viewMode === "simulation" && selectedId && (
            <div
              className={[
                "vision-simulation-status",
                simulationPlaying ? "is-playing" : "",
                interactionPath.length === 0 ? "is-empty" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <span className="vision-simulation-status__icon">
                <Route size={15} />
              </span>
              <span className="vision-simulation-status__copy">
                <small>SOURCE-BACKED PATH</small>
                <strong>
                  {interactionPath.length === 0
                    ? "未找到跨模块源码证据"
                    : simulationPlaying
                      ? `正在推演 ${simulationStep + 1} / ${interactionPath.length}`
                      : `推演完成 · ${interactionPath.length} 段交互`}
                </strong>
                {activeEvidence && (
                  <span>
                    {activeEvidence.file}
                    {activeEvidence.line ? `:${activeEvidence.line}` : ""}
                  </span>
                )}
              </span>
              {interactionPath.length > 0 && (
                <button
                  type="button"
                  title="重新推演"
                  aria-label="重新推演"
                  onClick={() => setSimulationRun((current) => current + 1)}
                >
                  <RotateCcw size={14} />
                </button>
              )}
            </div>
          )}

          {analysisRunning && latestJob && (
            <AnalysisProgress job={latestJob} events={currentAnalysisEvents} />
          )}

          {!analysisRunning &&
            (currentAnalysisEvent?.phase ?? latestJob?.phase) === "failed" && (
            <div
              className="vision-analysis-status is-error"
            >
              <LoaderCircle size={14} />
              <span>
                <strong>{currentAnalysisEvent?.message ?? latestJob?.message}</strong>
                <small>
                  {currentAnalysisEvent?.progress ?? latestJob?.progress ?? 0}% ·{" "}
                  {currentAnalysisEvent?.phase ?? latestJob?.phase}
                </small>
              </span>
            </div>
          )}
        </div>

        <CodeChat
          projectId={projectId}
          entity={selectedEntity}
          scope={selectedScope}
          collapsed={chatCollapsed}
          onToggle={() => setChatCollapsed((current) => !current)}
        />
        <CodeInspector
          projectId={projectId}
          context={context}
          onClose={clearSelection}
          onChanged={() =>
            void Promise.all([loadContext(), loadDocuments()])
          }
        />
      </section>

      {error && (
        <div className="vision-toast is-error">
          <span>{error}</span>
          <button type="button" onClick={() => setError("")}>
            <X size={14} />
          </button>
        </div>
      )}

      {importOpen && (
        <div className="vision-modal-backdrop" role="presentation">
          <form
            className="vision-import-dialog"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError("");
              try {
                const created = await visionApi.createProject({
                  name: repoName,
                  repoPath,
                  description: repoDescription,
                });
                await loadProjects();
                setProjectId(created.id);
                const job = await visionApi.analyze(created.id, true);
                setAnalysisEvents([]);
                setJobs([job]);
                setImportOpen(false);
                setRepoName("");
                setRepoPath("");
                setRepoDescription("");
              } catch (importError) {
                setError((importError as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <header>
              <div>
                <span>LOCAL REPOSITORY</span>
                <h2>导入代码仓库</h2>
              </div>
              <button
                type="button"
                onClick={() => setImportOpen(false)}
                aria-label="关闭"
              >
                <X size={16} />
              </button>
            </header>
            <label>
              项目名称
              <input
                required
                value={repoName}
                onChange={(event) => setRepoName(event.target.value)}
                placeholder="My Project"
              />
            </label>
            <label>
              本地仓库绝对路径
              <div className="vision-path-input">
                <FolderCode size={15} />
                <input
                  required
                  value={repoPath}
                  onChange={(event) => setRepoPath(event.target.value)}
                  placeholder="/Users/name/workspace/project"
                />
                {window.visionOwlDesktop && (
                  <button
                    type="button"
                    onClick={async () => {
                      const selectedPath =
                        await window.visionOwlDesktop?.selectDirectory();
                      if (!selectedPath) return;
                      setRepoPath(selectedPath);
                      if (!repoName) {
                        setRepoName(selectedPath.split(/[\\/]/).filter(Boolean).at(-1) || "");
                      }
                    }}
                  >
                    选择
                  </button>
                )}
              </div>
            </label>
            <label>
              项目说明
              <textarea
                rows={3}
                value={repoDescription}
                onChange={(event) => setRepoDescription(event.target.value)}
                placeholder="项目负责的业务与边界"
              />
            </label>
            <div className="vision-analyzer-row">
              <Sparkles size={15} />
              <span>
                <strong>Understand-Anything</strong>
                <small>原始 understand Skill · 七阶段知识图谱分析</small>
              </span>
            </div>
            <footer>
              <button type="button" onClick={() => setImportOpen(false)}>
                取消
              </button>
              <button type="submit" disabled={busy}>
                {busy ? <LoaderCircle size={15} className="is-spinning" /> : <GitBranch size={15} />}
                创建并分析
              </button>
            </footer>
          </form>
        </div>
      )}
    </main>
  );
}
