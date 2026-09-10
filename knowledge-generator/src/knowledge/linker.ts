import { createHash } from "node:crypto";
import type { CodeGraphDocument, CodeGraphNode, KnowledgeRunCommand, RepositorySnapshot } from "../codegraph/types.js";
import type { EvidenceEdge, EvidenceNode } from "../domain/types.js";
import type {
  EvidenceModuleLink,
  LinkedEvidenceGraph,
  ModuleEvidenceBundle,
  RepositoryEvidenceInput,
  UnresolvedEvidenceLink,
} from "./types.js";

const PROPAGATED_RELATIONS = new Set([
  "COMMIT_CHANGES_FILE",
  "FILE_CHANGE_TARGETS_FILE",
  "PR_CHANGES_FILE",
  "PR_CONTAINS_COMMIT",
  "PR_HAS_REVIEW",
  "PR_HAS_COMMENT",
  "REVIEW_HAS_COMMENT",
  "COMMENT_REPLIES_TO",
  "COMMENT_TARGETS_FILE",
  "CI_VALIDATES_COMMIT",
  "CI_VALIDATES_CHANGE_REQUEST",
  "CI_CONTAINS_JOB",
  "PR_MERGED_AS_COMMIT",
]);

interface RepositoryContext {
  repository: RepositorySnapshot;
  evidenceRepositoryId: string;
  aliases: Set<string>;
  graphCommitSha: string;
}

interface IndexedModule {
  node: CodeGraphNode;
  repository: RepositoryContext;
  normalizedPath: string;
}

export function linkEvidenceToCodeGraph(
  command: KnowledgeRunCommand,
  graph: CodeGraphDocument,
  repositories: RepositoryEvidenceInput[],
): LinkedEvidenceGraph {
  const contexts = repositoryContexts(command, graph, repositories);
  const moduleIndex = buildModuleIndex(graph, contexts);
  const linksByEvidence = new Map<string, Map<string, EvidenceModuleLink>>();
  const evidenceById = new Map<string, EvidenceNode>();
  const evidenceRepository = new Map<string, RepositoryContext>();

  for (const input of repositories) {
    const context = contexts.find((item) => item.evidenceRepositoryId === input.snapshot.repository.repositoryId);
    if (!context) continue;
    for (const evidence of input.snapshot.nodes) {
      evidenceById.set(evidence.id, evidence);
      evidenceRepository.set(evidence.id, context);
      const filePath = evidencePath(evidence);
      if (!filePath) continue;
      const module = resolveModule(filePath, evidence, context, graph, moduleIndex);
      if (!module) continue;
      addLink(linksByEvidence, directLink(evidence, module.node, context, filePath));
    }
  }

  const allEdges = repositories.flatMap((input) => input.snapshot.edges);
  propagateRelations(allEdges, evidenceById, evidenceRepository, linksByEvidence);

  const links = [...linksByEvidence.values()]
    .flatMap((moduleLinks) => [...moduleLinks.values()])
    .sort(compareLinks);
  const unresolved = unresolvedEvidence(repositories, linksByEvidence);
  return {
    schemaVersion: "knowledge-link.v1",
    projectId: command.projectId,
    graphCommitSha: graph.commitSha,
    generatedAt: new Date().toISOString(),
    links,
    unresolved,
    stats: {
      linkedEvidence: linksByEvidence.size,
      exactLinks: links.filter((link) => link.confidence === "exact_commit_path").length,
      historicalLinks: links.filter((link) => link.confidence === "historical_path").length,
      derivedLinks: links.filter((link) => link.confidence === "derived_relation").length,
      unresolvedEvidence: unresolved.length,
    },
  };
}

export function buildModuleEvidenceBundles(
  graph: CodeGraphDocument,
  repositories: RepositoryEvidenceInput[],
  linked: LinkedEvidenceGraph,
): ModuleEvidenceBundle[] {
  const evidenceById = new Map(repositories.flatMap((input) => input.snapshot.nodes).map((node) => [node.id, node]));
  const repositoryByAlias = new Map<string, RepositorySnapshot>();
  for (const input of repositories) {
    const repository = input.repository;
    for (const alias of repositoryAliases(repository, input.snapshot.repository.repositoryId)) {
      repositoryByAlias.set(alias, repository);
    }
  }
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const linksByModule = groupBy(linked.links, (link) => link.moduleId);
  return graph.nodes
    .filter(isKnowledgeModule)
    .map((module) => {
      const links = linksByModule.get(module.id) ?? [];
      const repository = resolveRepositoryForNode(module, repositoryByAlias, repositories);
      return {
        module,
        repository,
        links,
        evidence: unique(links.map((link) => evidenceById.get(link.evidenceId)).filter(isDefined), (item) => item.id)
          .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt)),
        incoming: graph.edges
          .filter((edge) => edge.target === module.id)
          .map((edge) => ({ source: nodeById.get(edge.source)?.name ?? edge.source, type: edge.type, label: edge.label })),
        outgoing: graph.edges
          .filter((edge) => edge.source === module.id)
          .map((edge) => ({ target: nodeById.get(edge.target)?.name ?? edge.target, type: edge.type, label: edge.label })),
      };
    })
    .sort((left, right) => moduleRank(right.module) - moduleRank(left.module) || left.module.name.localeCompare(right.module.name));
}

function repositoryContexts(
  command: KnowledgeRunCommand,
  graph: CodeGraphDocument,
  repositories: RepositoryEvidenceInput[],
): RepositoryContext[] {
  return repositories.map((input) => {
    const repository = command.repositorySnapshots.find((item) => item.bindingId === input.repository.bindingId)
      ?? input.repository;
    if (!repository.commitSha) throw new Error(`${repository.repoFullName} has no frozen commit`);
    const graphCommitSha = graph.repositoryCommits?.[repository.repositoryKey] ?? repository.commitSha;
    if (graphCommitSha !== repository.commitSha) throw new Error(`graph commit mismatch for ${repository.repoFullName}`);
    return {
      repository,
      evidenceRepositoryId: input.snapshot.repository.repositoryId,
      aliases: repositoryAliases(repository, input.snapshot.repository.repositoryId),
      graphCommitSha,
    };
  });
}

function repositoryAliases(repository: RepositorySnapshot, evidenceRepositoryId: string): Set<string> {
  const values = [
    repository.repositoryKey,
    repository.repoFullName,
    evidenceRepositoryId,
    evidenceRepositoryId.replace(/^github:/, ""),
  ];
  return new Set(values.map(normalizeAlias));
}

function buildModuleIndex(graph: CodeGraphDocument, contexts: RepositoryContext[]): IndexedModule[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.nodes
    .filter(isKnowledgeModule)
    .flatMap((node) => {
      const repository = contextForNode(node, contexts);
      if (!repository) return [];
      return modulePaths(node, byId).map((normalizedPath) => ({ node, repository, normalizedPath }));
    })
    .sort((left, right) => right.normalizedPath.length - left.normalizedPath.length || left.node.id.localeCompare(right.node.id));
}

function modulePaths(node: CodeGraphNode, byId: Map<string, CodeGraphNode>): string[] {
  const members = (node.architecture?.memberNodeIds ?? [])
    .map((id) => byId.get(id))
    .filter(isDefined);
  const candidates = [
    node.path,
    ...(node.evidence ?? []).map((item) => item.file),
    ...members.flatMap((member) => [
      member.path,
      ...(member.evidence ?? []).map((item) => item.file),
    ]),
  ].filter(isDefined).map(normalizePath);
  return [...new Set(candidates.length > 0 ? candidates : ["."])];
}

function resolveModule(
  filePath: string,
  evidence: EvidenceNode,
  context: RepositoryContext,
  graph: CodeGraphDocument,
  index: IndexedModule[],
): IndexedModule | undefined {
  const normalized = normalizePath(filePath);
  const candidates = index.filter((item) => item.repository === context && pathContains(item.normalizedPath, normalized));
  if (candidates.length > 0) return candidates[0];

  const evidenceNode = graph.nodes.find((node) => {
    if (contextForNode(node, [context]) !== context) return false;
    return normalizePath(node.path ?? "") === normalized
      || node.evidence?.some((item) => normalizePath(item.file) === normalized);
  });
  if (!evidenceNode) return undefined;
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  let current: CodeGraphNode | undefined = evidenceNode;
  while (current) {
    if (isKnowledgeModule(current)) return index.find((item) => item.node.id === current!.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  void evidence;
  return undefined;
}

function directLink(
  evidence: EvidenceNode,
  module: CodeGraphNode,
  context: RepositoryContext,
  filePath: string,
): EvidenceModuleLink {
  const exact = evidence.commitSha === context.graphCommitSha
    || (evidence.kind === "file" && evidence.state === "tracked");
  const confidence = exact ? "exact_commit_path" : "historical_path";
  return {
    id: linkId(evidence.id, module.id, confidence),
    evidenceId: evidence.id,
    moduleId: module.id,
    repositoryId: context.evidenceRepositoryId,
    filePath: normalizePath(filePath),
    evidenceCommitSha: evidence.commitSha,
    graphCommitSha: context.graphCommitSha,
    confidence,
    basis: exact
      ? "same repository and exact normalized file path at the frozen graph commit"
      : "same immutable repository and unambiguous normalized historical file path",
  };
}

function propagateRelations(
  edges: EvidenceEdge[],
  evidenceById: Map<string, EvidenceNode>,
  evidenceRepository: Map<string, RepositoryContext>,
  linksByEvidence: Map<string, Map<string, EvidenceModuleLink>>,
): void {
  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false;
    for (const edge of edges) {
      if (!PROPAGATED_RELATIONS.has(edge.relationType)) continue;
      changed = copyLinks(edge.fromId, edge.toId, edge, evidenceById, evidenceRepository, linksByEvidence) || changed;
      changed = copyLinks(edge.toId, edge.fromId, edge, evidenceById, evidenceRepository, linksByEvidence) || changed;
    }
    if (!changed) break;
  }
}

function copyLinks(
  sourceId: string,
  targetId: string,
  edge: EvidenceEdge,
  evidenceById: Map<string, EvidenceNode>,
  evidenceRepository: Map<string, RepositoryContext>,
  linksByEvidence: Map<string, Map<string, EvidenceModuleLink>>,
): boolean {
  const sourceLinks = linksByEvidence.get(sourceId);
  const target = evidenceById.get(targetId);
  const context = evidenceRepository.get(targetId);
  if (!sourceLinks || !target || !context) return false;
  let changed = false;
  for (const link of sourceLinks.values()) {
    const next: EvidenceModuleLink = {
      ...link,
      id: linkId(targetId, link.moduleId, "derived_relation"),
      evidenceId: targetId,
      evidenceCommitSha: target.commitSha,
      confidence: "derived_relation",
      basis: `${edge.relationType}: ${edge.basis}`,
    };
    changed = addLink(linksByEvidence, next) || changed;
  }
  return changed;
}

function addLink(
  linksByEvidence: Map<string, Map<string, EvidenceModuleLink>>,
  link: EvidenceModuleLink,
): boolean {
  const current = linksByEvidence.get(link.evidenceId) ?? new Map<string, EvidenceModuleLink>();
  const existing = current.get(link.moduleId);
  if (existing && confidenceRank(existing.confidence) >= confidenceRank(link.confidence)) return false;
  current.set(link.moduleId, link);
  linksByEvidence.set(link.evidenceId, current);
  return true;
}

function unresolvedEvidence(
  repositories: RepositoryEvidenceInput[],
  linksByEvidence: Map<string, Map<string, EvidenceModuleLink>>,
): UnresolvedEvidenceLink[] {
  const relevant = new Set(["commit", "change_request", "review", "comment", "ci_run", "ci_job", "file_change"]);
  return repositories.flatMap((input) => input.snapshot.nodes.flatMap((node) => {
    if (!relevant.has(node.kind) || linksByEvidence.has(node.id)) return [];
    const filePath = evidencePath(node);
    return [{
      evidenceId: node.id,
      repositoryId: input.snapshot.repository.repositoryId,
      reason: filePath ? "no_module_match" as const : "no_path" as const,
      filePath,
    }];
  })).sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
}

function evidencePath(node: EvidenceNode): string | undefined {
  for (const candidate of [node.payload.path, node.payload.previousPath, node.kind === "file" ? node.externalId : undefined]) {
    if (typeof candidate === "string" && candidate.trim()) return normalizePath(candidate);
  }
  return undefined;
}

function isKnowledgeModule(node: CodeGraphNode): boolean {
  return node.kind === "module"
    || node.kind === "submodule"
    || node.kind === "domain"
    || node.architecture?.importance === "primary"
    || node.architecture?.importance === "supporting";
}

function contextForNode(node: CodeGraphNode, contexts: RepositoryContext[]): RepositoryContext | undefined {
  const aliases = [node.repositoryId, ...((node.evidence ?? []).map((item) => item.repositoryId))]
    .filter(isDefined)
    .map(normalizeAlias);
  if (aliases.length === 0) return contexts.length === 1 ? contexts[0] : undefined;
  return contexts.find((context) => aliases.some((alias) => context.aliases.has(alias)));
}

function resolveRepositoryForNode(
  node: CodeGraphNode,
  byAlias: Map<string, RepositorySnapshot>,
  repositories: RepositoryEvidenceInput[],
): RepositorySnapshot | undefined {
  const aliases = [node.repositoryId, ...((node.evidence ?? []).map((item) => item.repositoryId))]
    .filter(isDefined)
    .map(normalizeAlias);
  for (const alias of aliases) {
    const repository = byAlias.get(alias);
    if (repository) return repository;
  }
  return repositories.length === 1 ? repositories[0]?.repository : undefined;
}

function normalizePath(value: string): string {
  const path = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return path || ".";
}

function pathContains(modulePath: string, filePath: string): boolean {
  return modulePath === "." || filePath === modulePath || filePath.startsWith(`${modulePath}/`);
}

function normalizeAlias(value: string): string {
  return value.trim().toLowerCase().replace(/^github:/, "");
}

function linkId(evidenceId: string, moduleId: string, confidence: string): string {
  return `knowledge-link:${createHash("sha256").update(`${evidenceId}:${moduleId}:${confidence}`).digest("hex").slice(0, 24)}`;
}

function confidenceRank(value: EvidenceModuleLink["confidence"]): number {
  return value === "exact_commit_path" ? 3 : value === "historical_path" ? 2 : 1;
}

function moduleRank(node: CodeGraphNode): number {
  const importance = node.architecture?.importance;
  return importance === "primary" ? 30 : importance === "supporting" ? 20 : node.kind === "module" ? 10 : 0;
}

function compareLinks(left: EvidenceModuleLink, right: EvidenceModuleLink): number {
  return left.moduleId.localeCompare(right.moduleId) || left.evidenceId.localeCompare(right.evidenceId);
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) result.set(key(item), [...(result.get(key(item)) ?? []), item]);
  return result;
}

function unique<T>(items: T[], key: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
