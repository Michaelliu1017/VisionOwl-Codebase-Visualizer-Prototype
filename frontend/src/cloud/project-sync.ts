import type {
  AnalysisJob,
  CloudGraphVersion,
  CloudProject,
  Project,
  SanitizedGraphArtifact,
} from "@visionowl/contracts";
import { visionApi } from "../code/api";
import { cloudApi } from "./cloud-api";

export type ProjectSyncPhase =
  | "binding"
  | "analyzing"
  | "sanitizing"
  | "uploading"
  | "activating"
  | "complete"
  | "failed";

export type ProjectSyncProgress = {
  cloudProjectId: string;
  localProjectId?: string;
  phase: ProjectSyncPhase;
  progress: number;
  message: string;
  job?: AnalysisJob;
};

type ProgressHandler = (progress: ProjectSyncProgress) => void;

function pause(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function waitForAnalysis(
  cloudProjectId: string,
  localProjectId: string,
  jobId: string,
  onProgress: ProgressHandler,
) {
  while (true) {
    const jobs = await visionApi.listJobs(localProjectId);
    const job = jobs.find((value) => value.id === jobId);
    if (!job) throw new Error("本地分析任务不存在，请重新运行同步。");
    onProgress({
      cloudProjectId,
      localProjectId,
      phase: "analyzing",
      progress: Math.min(84, 8 + Math.round(job.progress * 0.76)),
      message: job.message,
      job,
    });
    if (job.status === "completed") return job;
    if (job.status === "failed") {
      throw new Error(job.error || job.message || "代码仓库分析失败。");
    }
    await pause(650);
  }
}

export async function bindRepository(input: {
  cloudProject: CloudProject;
  localProjects: Project[];
  repoPath: string;
  description?: string;
  onProgress: ProgressHandler;
}) {
  const normalizedPath = input.repoPath.trim().replace(/[\\/]$/, "");
  input.onProgress({
    cloudProjectId: input.cloudProject.id,
    phase: "binding",
    progress: 3,
    message: "正在绑定本地仓库",
  });
  const existing = input.localProjects.find(
    (project) => project.repoPath.replace(/[\\/]$/, "") === normalizedPath,
  );
  if (existing) {
    if (
      existing.cloudProjectId &&
      existing.cloudProjectId !== input.cloudProject.id
    ) {
      throw new Error("该本地仓库已经绑定到另一个团队 Project。");
    }
    return existing.cloudProjectId
      ? existing
      : visionApi.bindCloudProject(existing.id, input.cloudProject.id);
  }
  return visionApi.createProject({
    name: input.cloudProject.name,
    description: input.description,
    repoPath: normalizedPath,
    cloudProjectId: input.cloudProject.id,
  });
}

export async function analyzeAndPublish(input: {
  cloudProject: CloudProject;
  localProject: Project;
  onProgress: ProgressHandler;
}): Promise<CloudGraphVersion> {
  const { cloudProject, localProject, onProgress } = input;
  try {
    const job = await visionApi.analyze(localProject.id, true);
    await waitForAnalysis(cloudProject.id, localProject.id, job.id, onProgress);

    onProgress({
      cloudProjectId: cloudProject.id,
      localProjectId: localProject.id,
      phase: "sanitizing",
      progress: 88,
      message: "正在移除源码片段、主机路径和敏感元数据",
    });
    const localArtifact = await visionApi.getSanitizedGraph(localProject.id);
    const artifact: SanitizedGraphArtifact = {
      ...localArtifact,
      project: { id: cloudProject.id, name: cloudProject.name },
    };

    onProgress({
      cloudProjectId: cloudProject.id,
      localProjectId: localProject.id,
      phase: "uploading",
      progress: 94,
      message: "正在上传脱敏图谱",
    });
    const version = await cloudApi.uploadGraph(cloudProject.id, artifact, {
      engineVersion: "visionowl-local/0.1.0",
      skillVersion: "understand-anything",
    });

    onProgress({
      cloudProjectId: cloudProject.id,
      localProjectId: localProject.id,
      phase: "activating",
      progress: 98,
      message: "正在激活新的团队图谱版本",
    });
    const active = await cloudApi.activateGraph(cloudProject.id, version.id);
    onProgress({
      cloudProjectId: cloudProject.id,
      localProjectId: localProject.id,
      phase: "complete",
      progress: 100,
      message: "分析完成，团队图谱已同步",
    });
    return active;
  } catch (error) {
    onProgress({
      cloudProjectId: cloudProject.id,
      localProjectId: localProject.id,
      phase: "failed",
      progress: 100,
      message: (error as Error).message,
    });
    throw error;
  }
}
