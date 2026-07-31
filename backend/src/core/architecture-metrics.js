"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { fileNodeId } = require("./understand-static-graph");

const WORKSPACE_BOUNDARY = "__workspace__";
const MAX_GROUPS_PER_REPOSITORY = 4;

function stableGroupId(paths) {
  const digest = createHash("sha1")
    .update([...paths].sort().join("\n"))
    .digest("hex")
    .slice(0, 10);
  return `layer:direct-${digest}`;
}

function commonDirectory(paths) {
  if (paths.length === 0) return "";
  const split = paths.map((value) => value.split("/").slice(0, -1));
  const result = [];
  const shortest = Math.min(...split.map((parts) => parts.length));
  for (let index = 0; index < shortest; index += 1) {
    const value = split[0][index];
    if (!split.every((parts) => parts[index] === value)) break;
    result.push(value);
  }
  return result.join("/");
}

function displayName(value) {
  return String(value || "")
    .split("/")
    .filter(Boolean)
    .at(-1)
    ?.replace(/[-_.]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function dominant(values, fallback) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return (
    [...counts.entries()].sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )[0]?.[0] || fallback
  );
}

function deterministicLayerName(files) {
  const category = dominant(files.map((file) => file.fileCategory), "code");
  const directory = commonDirectory(files.map((file) => file.path));
  if (category === "docs") return "项目文档";
  if (category === "config") return "工程配置";
  if (category === "infra") return "基础设施与交付";
  if (category === "data") return "数据与接口定义";
  if (category === "script") return "自动化脚本";
  if (directory) return `${displayName(directory)} 模块`;
  const firstStem = path.basename(files[0]?.path || "core", path.extname(files[0]?.path || ""));
  return `${displayName(firstStem) || "核心"} 模块`;
}

function groupFromFiles(files, repository = ".") {
  const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path));
  return {
    id: stableGroupId(sorted.map((file) => file.path)),
    files: sorted,
    repository,
  };
}

function initialGroups(scan, batches) {
  const fileByPath = new Map((scan.files || []).map((file) => [file.path, file]));
  return (batches.batches || [])
    .map((batch) =>
      groupFromFiles(
        (batch.files || [])
          .map((file) => fileByPath.get(file.path))
          .filter(Boolean),
      ),
    )
    .filter((group) => group.files.length > 0);
}

function repositoryCandidates(scan) {
  const candidates = new Set([""]);
  for (const file of scan.files || []) {
    const directories = String(file.path || "")
      .replaceAll("\\", "/")
      .split("/")
      .filter(Boolean)
      .slice(0, -1);
    for (let depth = 1; depth <= directories.length; depth += 1) {
      candidates.add(directories.slice(0, depth).join("/"));
    }
  }
  return [...candidates].sort(
    (left, right) =>
      right.split("/").filter(Boolean).length -
        left.split("/").filter(Boolean).length ||
      left.localeCompare(right),
  );
}

function detectRepositoryRoots(repoPath, scan) {
  if (!repoPath) return [];
  return repositoryCandidates(scan).filter((candidate) =>
    fs.existsSync(path.join(repoPath, candidate, ".git")),
  );
}

function repositoryForPath(filePath, repositoryRoots) {
  const normalized = String(filePath || "")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "");
  const owner = repositoryRoots.find(
    (root) => !root || normalized === root || normalized.startsWith(`${root}/`),
  );
  if (owner !== undefined) return owner || ".";
  return repositoryRoots.some(Boolean) ? WORKSPACE_BOUNDARY : ".";
}

function splitGroupsByRepository(groups, repositoryRoots) {
  return groups.flatMap((group) => {
    const filesByRepository = new Map();
    for (const file of group.files) {
      const repository = repositoryForPath(file.path, repositoryRoots);
      filesByRepository.set(repository, [
        ...(filesByRepository.get(repository) || []),
        file,
      ]);
    }
    return [...filesByRepository.entries()].map(([repository, files]) =>
      groupFromFiles(files, repository),
    );
  });
}

function categoryGroups(scan, repositoryRoots) {
  const values = new Map();
  for (const file of scan.files || []) {
    const repository = repositoryForPath(file.path, repositoryRoots);
    let key = file.fileCategory;
    if (file.fileCategory === "code" || file.fileCategory === "script") {
      const repositoryRelativePath =
        repository !== "." &&
        repository !== WORKSPACE_BOUNDARY &&
        file.path.startsWith(`${repository}/`)
          ? file.path.slice(repository.length + 1)
          : file.path;
      const top = repositoryRelativePath.includes("/")
        ? repositoryRelativePath.split("/")[0]
        : "root-code";
      key = `code:${top}`;
    }
    const scopedKey = `${repository}\u0000${key}`;
    const files = values.get(scopedKey) || [];
    files.push(file);
    values.set(scopedKey, files);
  }
  return [...values.entries()].map(([scopedKey, files]) =>
    groupFromFiles(files, scopedKey.split("\u0000")[0]),
  );
}

function mergeSmallestGroups(values, maximum) {
  const result = [...values];
  while (result.length > maximum) {
    result.sort(
      (left, right) =>
        left.files.length - right.files.length ||
        left.files[0].path.localeCompare(right.files[0].path),
    );
    const smallest = result.shift();
    const sameCategory = result.find(
      (candidate) =>
        dominant(candidate.files.map((file) => file.fileCategory)) ===
        dominant(smallest.files.map((file) => file.fileCategory)),
    );
    const target = sameCategory || result[0];
    target.files = [...target.files, ...smallest.files].sort((left, right) =>
      left.path.localeCompare(right.path),
    );
    target.id = stableGroupId(target.files.map((file) => file.path));
  }
  return result;
}

function normalizeGroupCount(scan, groups, repositoryRoots) {
  const categories = categoryGroups(scan, repositoryRoots);
  const repositoryNames = new Set([
    ...groups.map((group) => group.repository),
    ...categories.map((group) => group.repository),
  ]);
  const hasIndependentRepositories =
    [...repositoryNames].filter((value) => value !== WORKSPACE_BOUNDARY).length >
    1;
  const values = [];

  for (const repository of repositoryNames) {
    let scoped = groups.filter((group) => group.repository === repository);
    const scopedCategories = categories.filter(
      (group) => group.repository === repository,
    );
    const fileCount = (scoped.length > 0 ? scoped : scopedCategories).reduce(
      (count, group) => count + group.files.length,
      0,
    );
    const targetMinimum = Math.min(
      hasIndependentRepositories ? 2 : 3,
      fileCount,
    );
    if (
      scoped.length < targetMinimum &&
      scopedCategories.length > scoped.length
    ) {
      scoped = scopedCategories;
    }
    values.push(
      ...mergeSmallestGroups(
        scoped,
        hasIndependentRepositories ? MAX_GROUPS_PER_REPOSITORY : 10,
      ),
    );
  }

  return values.sort((left, right) => {
    const repositoryOrder = left.repository.localeCompare(right.repository);
    if (repositoryOrder !== 0) return repositoryOrder;
    return left.files[0].path.localeCompare(right.files[0].path);
  });
}

function repositoryLabel(repository) {
  if (!repository || repository === ".") return "";
  if (repository === WORKSPACE_BOUNDARY) return "Workspace";
  return displayName(repository) || repository;
}

function buildArchitectureGroups({ scan, batches, graph, repoPath }) {
  const repositoryRoots = detectRepositoryRoots(repoPath, scan);
  const initial = splitGroupsByRepository(
    initialGroups(scan, batches),
    repositoryRoots,
  );
  const groups = normalizeGroupCount(scan, initial, repositoryRoots);
  const groupsPerRepository = new Map();
  for (const group of groups) {
    groupsPerRepository.set(
      group.repository,
      (groupsPerRepository.get(group.repository) || 0) + 1,
    );
  }
  const groupByNode = new Map();
  for (const group of groups) {
    group.nodeIds = group.files.map(fileNodeId);
    for (const nodeId of group.nodeIds) groupByNode.set(nodeId, group.id);
  }

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const node of graph.nodes) {
    if (!node.filePath || groupByNode.has(node.id)) continue;
    const file = (scan.files || []).find((item) => item.path === node.filePath);
    const owner = file ? groupByNode.get(fileNodeId(file)) : null;
    if (owner) groupByNode.set(node.id, owner);
  }

  const edgeCounts = new Map();
  for (const edge of graph.edges) {
    const source = groupByNode.get(edge.source);
    const target = groupByNode.get(edge.target);
    if (!source || !target || source === target) continue;
    const key = `${source}|${target}`;
    edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
  }

  return groups.map((group) => {
    const fileNodes = group.nodeIds.map((id) => nodeById.get(id)).filter(Boolean);
    const categories = group.files.map((file) => file.fileCategory);
    const languages = group.files.map((file) => file.language);
    const inbound = [...edgeCounts.entries()]
      .filter(([key]) => key.endsWith(`|${group.id}`))
      .reduce((sum, [, count]) => sum + count, 0);
    const outbound = [...edgeCounts.entries()]
      .filter(([key]) => key.startsWith(`${group.id}|`))
      .reduce((sum, [, count]) => sum + count, 0);
    const repository = repositoryLabel(group.repository);
    const onlyGroupInRepository =
      groupsPerRepository.get(group.repository) === 1 && repository;
    const defaultName = onlyGroupInRepository
      ? `${repository} 核心模块`
      : deterministicLayerName(group.files);
    return {
      id: group.id,
      repository: group.repository,
      defaultName,
      defaultDescription: `${defaultName}属于${
        repository || "当前项目"
      }，包含 ${group.files.length} 个文件，主要语言为 ${dominant(
        languages,
        "unknown",
      )}，跨模块入向依赖 ${inbound} 条、出向依赖 ${outbound} 条。`,
      nodeIds: group.nodeIds,
      facts: {
        repository: repository || undefined,
        repositoryPath:
          group.repository === WORKSPACE_BOUNDARY
            ? undefined
            : group.repository,
        fileCount: group.files.length,
        paths: group.files.map((file) => file.path).slice(0, 40),
        categories: [...new Set(categories)],
        languages: [...new Set(languages)],
        summaries: fileNodes.map((node) => node.summary).slice(0, 20),
        inbound,
        outbound,
      },
    };
  });
}

function buildLayers(groups, semanticArchitecture) {
  const enrichment = new Map(
    (semanticArchitecture?.layers || []).map((layer) => [layer.id, layer]),
  );
  return groups.map((group) => {
    const value = enrichment.get(group.id);
    return {
      id: group.id,
      name: value?.name || group.defaultName,
      description: value?.description || group.defaultDescription,
      repository: group.repository,
      nodeIds: group.nodeIds,
    };
  });
}

function buildTour(layers, semanticArchitecture) {
  const semanticTour = new Map(
    (semanticArchitecture?.tour || []).map((step) => [step.layerId, step]),
  );
  const ordered = [...layers].sort((left, right) => {
    const score = (layer) => {
      if (/文档/.test(layer.name)) return 0;
      if (/入口|核心|服务/.test(layer.name)) return 1;
      if (/配置|基础设施/.test(layer.name)) return 3;
      return 2;
    };
    return score(left) - score(right) || left.name.localeCompare(right.name);
  });
  return ordered.map((layer, index) => {
    const value = semanticTour.get(layer.id);
    return {
      order: index + 1,
      title: value?.title || layer.name,
      description: value?.description || layer.description,
      nodeIds: layer.nodeIds.slice(0, 6),
    };
  });
}

module.exports = {
  buildArchitectureGroups,
  buildLayers,
  buildTour,
};
