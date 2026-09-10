import type { CodeGraphDocument, CodeGraphNode, RepositorySnapshot } from "../codegraph/types.js";
import type { EvidenceNode, EvidenceSnapshot } from "../domain/types.js";

export interface EvidenceModuleLink {
  id: string;
  evidenceId: string;
  moduleId: string;
  repositoryId: string;
  filePath: string;
  evidenceCommitSha?: string;
  graphCommitSha: string;
  confidence: "exact_commit_path" | "historical_path" | "derived_relation";
  basis: string;
}

export interface UnresolvedEvidenceLink {
  evidenceId: string;
  repositoryId: string;
  reason: "no_path" | "no_module_match" | "ambiguous_repository";
  filePath?: string;
}

export interface LinkedEvidenceGraph {
  schemaVersion: "knowledge-link.v1";
  projectId: string;
  graphCommitSha: string;
  generatedAt: string;
  links: EvidenceModuleLink[];
  unresolved: UnresolvedEvidenceLink[];
  stats: {
    linkedEvidence: number;
    exactLinks: number;
    historicalLinks: number;
    derivedLinks: number;
    unresolvedEvidence: number;
  };
}

export interface RepositoryEvidenceInput {
  repository: RepositorySnapshot;
  snapshot: EvidenceSnapshot;
}

export interface ModuleEvidenceBundle {
  module: CodeGraphNode;
  repository?: RepositorySnapshot;
  evidence: EvidenceNode[];
  links: EvidenceModuleLink[];
  incoming: Array<{ source: string; type: string; label?: string }>;
  outgoing: Array<{ target: string; type: string; label?: string }>;
}

export interface DevelopmentStandard {
  title: string;
  rule: string;
  rationale: string;
  evidenceIds: string[];
}

export interface PitfallGuide {
  title: string;
  symptom: string;
  trigger: string;
  rootCause: string;
  fix: string;
  verification: string;
  evidenceIds: string[];
}

export interface SkillGuidance {
  name: string;
  description: string;
  trigger: string;
  steps: string[];
  validation: string[];
  evidenceIds: string[];
}

export interface SemanticKnowledge {
  overview?: string;
  standards: DevelopmentStandard[];
  pitfalls: PitfallGuide[];
  skills: SkillGuidance[];
  provider: "deterministic" | "qoder";
  warnings: string[];
}

export interface KnowledgeContext {
  graph: CodeGraphDocument;
  repositories: RepositoryEvidenceInput[];
  linked: LinkedEvidenceGraph;
  modules: ModuleEvidenceBundle[];
  semantic: SemanticKnowledge;
}

export interface KnowledgeFile {
  id: string;
  title: string;
  path: string;
  mediaType: "text/markdown; charset=utf-8" | "application/json; charset=utf-8";
  content: Buffer;
}

export interface GeneratedKnowledgeAsset {
  kind: "wiki" | "skills";
  title: string;
  files: KnowledgeFile[];
  summary: Record<string, unknown>;
}
