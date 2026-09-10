import { githubAppReady } from "../config";
import { getBranchHeadSha } from "../infra/githubApp";
import { getPublicBranchHeadSha } from "../infra/githubPublic";
import { projectSnapshotCommitSha } from "../scanner/v2/crossRepo";
import type { BindingDto } from "../types";
import { bindingRepositoryKey, listBindings } from "./repository";

export interface RepositorySnapshot {
  bindings: BindingDto[];
  repositoryCommits: Record<string, string>;
  targetCommitSha: string;
}

async function resolveBindingHead(binding: BindingDto): Promise<string> {
  if (binding.installationId && githubAppReady()) {
    return getBranchHeadSha(binding.installationId, binding.repoFullName, binding.branch);
  }
  return getPublicBranchHeadSha(binding.repoFullName, binding.branch);
}

/**
 * 在任务创建时冻结整个 Project 的仓库快照。Webhook 可覆盖已知的 push SHA，
 * 其余仓库优先读取当前远端 HEAD，临时不可达时复用最近一次成功 SHA。
 */
export async function resolveProjectRepositorySnapshot(
  projectId: string,
  overrides: Record<string, string> = {},
): Promise<RepositorySnapshot> {
  const bindings = await listBindings(projectId);
  if (bindings.length === 0) throw new Error("该项目尚未绑定仓库");

  const entries = await Promise.all(bindings.map(async (binding) => {
    const key = bindingRepositoryKey(binding);
    const explicit = overrides[key] ?? overrides[binding.repoFullName];
    if (explicit) return [key, explicit] as const;
    try {
      return [key, await resolveBindingHead(binding)] as const;
    } catch (error) {
      if (binding.currentCommitSha) return [key, binding.currentCommitSha] as const;
      throw error;
    }
  }));

  const repositoryCommits = Object.fromEntries(entries);
  return {
    bindings,
    repositoryCommits,
    targetCommitSha:
      entries.length === 1 ? entries[0]![1] : projectSnapshotCommitSha(repositoryCommits),
  };
}
