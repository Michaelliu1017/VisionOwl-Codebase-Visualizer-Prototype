"use strict";

const { repositoryState } = require("./git-repository");

class RepositoryWatcher {
  constructor(
    store,
    documents,
    { intervalMs = 10000, repositoryPolicy } = {},
  ) {
    if (!repositoryPolicy) {
      throw new Error("RepositoryWatcher requires a RepositoryPolicy.");
    }
    this.store = store;
    this.documents = documents;
    this.repositoryPolicy = repositoryPolicy;
    this.intervalMs = intervalMs;
    this.timer = undefined;
    this.running = new Set();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async enable(projectId, enabled) {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error("Project was not found.");
    if (!enabled) {
      return this.store.updateAutomationSettings(projectId, {
        debugMode: false,
        status: "idle",
        message: "Debug 文档同步未启用",
      });
    }
    const authorization = this.repositoryPolicy.authorizeProject(project);
    const state = await repositoryState(authorization.path, project.branch);
    this.repositoryPolicy.assertBranch(authorization, state.branch);
    return this.store.updateAutomationSettings(projectId, {
      debugMode: true,
      branch: state.branch,
      observedCommit: state.commit,
      processedCommit: state.commit,
      status: "watching",
      message: `正在监听本地 ${state.branch} 的新 Commit`,
    });
  }

  async tick() {
    for (const settings of this.store.listDebugAutomationSettings()) {
      if (this.running.has(settings.projectId)) continue;
      const project = this.store.getProject(settings.projectId);
      if (!project) continue;
      this.running.add(settings.projectId);
      try {
        const authorization = this.repositoryPolicy.authorizeProject(project, {
          branch: settings.branch || project.branch || undefined,
        });
        const state = await repositoryState(
          authorization.path,
          settings.branch || project.branch,
        );
        this.repositoryPolicy.assertBranch(authorization, state.branch);
        if (!settings.observedCommit) {
          this.store.updateAutomationSettings(project.id, {
            branch: state.branch,
            observedCommit: state.commit,
            processedCommit: state.commit,
            status: "watching",
            message: `已建立 ${state.branch} Commit 监听基线`,
          });
          continue;
        }
        const observedChanged = state.commit !== settings.observedCommit;
        const processingPending = state.commit !== settings.processedCommit;
        if (!observedChanged && !processingPending) continue;

        const before = settings.processedCommit || settings.observedCommit;
        this.store.updateAutomationSettings(project.id, {
          observedCommit: state.commit,
          status: "running",
          message: observedChanged
            ? `检测到新 Commit，正在分析 ${before.slice(0, 8)}..${state.commit.slice(0, 8)}`
            : `正在重试文档同步 ${before.slice(0, 8)}..${state.commit.slice(0, 8)}`,
        });
        const result = await this.documents.syncLocalCommit({
          project,
          before,
          after: state.commit,
        });
        this.store.updateAutomationSettings(project.id, {
          processedCommit: state.commit,
          status: "watching",
          message: `已分析 ${result.changedFiles} 个变化文件，更新 ${result.updatedDocuments} 篇文档`,
        });
      } catch (error) {
        this.store.updateAutomationSettings(settings.projectId, {
          status: "error",
          message: error.message,
        });
      } finally {
        this.running.delete(settings.projectId);
      }
    }
  }
}

module.exports = {
  RepositoryWatcher,
};
