import { buildGraphSkeleton, type Facts } from "../scan";
import type { ScanBundleV2 } from "./contracts";

export interface ScannerComparisonReport {
  schemaVersion: "1.0";
  repositoryId: string;
  commitSha: string;
  generatedAt: string;
  v1: {
    moduleCount: number;
    submoduleCount: number;
    nodeCount: number;
    edgeCount: number;
  };
  v2: {
    moduleCount: number;
    submoduleCount: number;
    factCount: number;
    nodeCount: number;
    edgeCount: number;
    interfaceCount: number;
    resourceCount: number;
    diagnosticCount: number;
  };
  delta: {
    nodeCount: number;
    edgeCount: number;
  };
}

export function compareScannerVersions(
  projectId: string,
  bundle: ScanBundleV2,
): ScannerComparisonReport {
  const legacyFacts: Facts = bundle.legacyFacts;
  const v1Graph = buildGraphSkeleton(legacyFacts, projectId, bundle.factIndex.commitSha);
  const v1 = {
    moduleCount: legacyFacts.modules.length,
    submoduleCount: legacyFacts.submodules.length,
    nodeCount: v1Graph.nodes.length,
    edgeCount: v1Graph.edges.length,
  };
  const v2 = {
    moduleCount: bundle.baseGraph.nodes.filter((node) => node.kind === "module").length,
    submoduleCount: bundle.baseGraph.nodes.filter((node) => node.kind === "submodule").length,
    factCount: bundle.factIndex.stats.factCount,
    nodeCount: bundle.baseGraph.nodes.length,
    edgeCount: bundle.baseGraph.edges.length,
    interfaceCount: bundle.interfaceCatalog.interfaces.length,
    resourceCount: bundle.resourceCatalog.resources.length,
    diagnosticCount: bundle.diagnostics.diagnostics.length,
  };
  return {
    schemaVersion: "1.0",
    repositoryId: bundle.factIndex.repositoryId,
    commitSha: bundle.factIndex.commitSha,
    generatedAt: new Date().toISOString(),
    v1,
    v2,
    delta: {
      nodeCount: v2.nodeCount - v1.nodeCount,
      edgeCount: v2.edgeCount - v1.edgeCount,
    },
  };
}
