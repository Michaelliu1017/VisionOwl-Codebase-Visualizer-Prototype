"use strict";

const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("node:events");
const { adaptUnderstandGraph } = require("./understand-adapter");
const { runUnderstandAnything } = require("./understand-anything");
const { repositoryState } = require("./git-repository");

class AnalysisService extends EventEmitter {
  constructor(
    store,
    {
      analyzeRepository = runUnderstandAnything,
      repositoryPolicy,
      repositoryStateImpl = repositoryState,
    } = {},
  ) {
    super();
    if (!repositoryPolicy) {
      throw new Error("AnalysisService requires a RepositoryPolicy.");
    }
    this.store = store;
    this.running = new Set();
    this.analyzeRepository = analyzeRepository;
    this.repositoryPolicy = repositoryPolicy;
    this.repositoryState = repositoryStateImpl;
  }

  publish(job, phase, progress, message) {
    const updated = this.store.updateJob(job.id, {
      phase,
      progress,
      message,
    });
    const event = this.store.addAnalysisEvent(
      job.id,
      job.projectId,
      phase,
      progress,
      message,
    );
    this.emit(`project:${job.projectId}`, event);
    return updated;
  }

  start(job) {
    if (this.running.has(job.id)) return;
    this.running.add(job.id);
    setImmediate(() =>
      this.execute(job).finally(() => {
        this.running.delete(job.id);
      }),
    );
  }

  async execute(job) {
    const project = this.store.getProject(job.projectId);
    if (!project) return;
    try {
      const authorization = this.repositoryPolicy.authorizeProject(project);
      const repoPath = path.resolve(authorization.path);
      const state = await this.repositoryState(repoPath, project.branch);
      this.repositoryPolicy.assertBranch(authorization, state.branch);
      const stat = fs.statSync(repoPath);
      if (!stat.isDirectory()) throw new Error("Repository path is not a directory.");

      const result = await this.analyzeRepository({
        repoPath,
        onProgress: (phase, progress, message) => {
          this.publish(job, phase, progress, message);
        },
        onGraph: (knowledgeGraph, state) => {
          const partialGraph = adaptUnderstandGraph(
            knowledgeGraph,
            project,
            repoPath,
          );
          this.store.saveGraph(project.id, partialGraph);
          this.publish(
            job,
            state.phase,
            state.progress,
            state.message,
          );
        },
      });

      this.publish(
        job,
        "ua_save",
        99,
        "正在将 Understand-Anything 架构层与源码关系转换为 VisionOwl 图谱",
      );
      const graph = adaptUnderstandGraph(
        result.knowledgeGraph,
        project,
        repoPath,
      );
      this.store.saveGraph(project.id, graph);
      this.publish(
        job,
        "ua_save",
        99,
        `已发布 ${graph.entities.length} 个架构模块和 ${graph.relations.length} 条关系`,
      );
      this.store.updateJob(job.id, {
        status: "completed",
        phase: "completed",
        progress: 100,
        message: "Understand-Anything 代码图谱分析完成",
      });
      const event = this.store.addAnalysisEvent(
        job.id,
        job.projectId,
        "completed",
        100,
        "Understand-Anything 代码图谱分析完成",
      );
      this.emit(`project:${job.projectId}`, event);
    } catch (error) {
      this.store.updateJob(job.id, {
        status: "failed",
        phase: "failed",
        progress: 100,
        message: "代码图谱分析失败",
        error: error.message,
      });
      const event = this.store.addAnalysisEvent(
        job.id,
        job.projectId,
        "failed",
        100,
        error.message,
      );
      this.emit(`project:${job.projectId}`, event);
    }
  }
}

module.exports = {
  AnalysisService,
};
