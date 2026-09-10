import type { GraphDocument } from "../types";
import { computeStats } from "./graphValidator";
import { baseGraphVersionFor, type GraphPatchOperation } from "./patchValidator";
import { orderGraphViews } from "./viewOrder";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function mergeAcceptedPatches(
  baseGraph: GraphDocument,
  operations: GraphPatchOperation[],
): GraphDocument {
  const graph = clone(baseGraph);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const edges = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const views = new Map((graph.views ?? []).map((view) => [view.id, view]));

  for (const operation of operations) {
    if (operation.op === "add_node" && operation.node) {
      nodes.set(operation.node.id, {
        ...clone(operation.node),
        inferred: operation.node.inferred ?? true,
        evidence: operation.node.evidence?.length ? operation.node.evidence : clone(operation.evidence),
      });
    } else if (operation.op === "add_edge" && operation.edge) {
      edges.set(operation.edge.id, {
        ...clone(operation.edge),
        inferred: operation.edge.inferred ?? true,
        evidence: operation.edge.evidence?.length ? operation.edge.evidence : clone(operation.evidence),
      });
    } else if (operation.op === "replace_edge" && operation.edgeId && operation.edge) {
      edges.delete(operation.edgeId);
      edges.set(operation.edge.id, {
        ...clone(operation.edge),
        inferred: operation.edge.inferred ?? true,
        evidence: operation.edge.evidence?.length ? operation.edge.evidence : clone(operation.evidence),
      });
      for (const view of views.values()) {
        view.edgeIds = view.edgeIds.map((id) => id === operation.edgeId ? operation.edge!.id : id);
        view.steps = view.steps?.map((step) =>
          step.edgeId === operation.edgeId ? { ...step, edgeId: operation.edge!.id } : step,
        );
      }
    } else if (operation.op === "suppress_edge" && operation.edgeId) {
      edges.delete(operation.edgeId);
      for (const view of views.values()) {
        view.edgeIds = view.edgeIds.filter((id) => id !== operation.edgeId);
        view.steps = view.steps?.filter((step) => step.edgeId !== operation.edgeId);
      }
    } else if (operation.op === "update_summary" && operation.nodeId && operation.summary) {
      const node = nodes.get(operation.nodeId);
      if (node) {
        node.summary = operation.summary.trim();
        node.inferred = true;
        node.evidence = clone(operation.evidence);
      }
    } else if (operation.op === "set_architecture" && operation.nodeId && operation.architecture) {
      const node = nodes.get(operation.nodeId);
      if (node) {
        node.architecture = {
          ...clone(operation.architecture),
          score: node.architecture?.score,
          source: "semantic",
        };
      }
    } else if (operation.op === "add_view" && operation.view) {
      views.set(operation.view.id, clone(operation.view));
    }
  }

  graph.nodes = [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id));
  graph.edges = [...edges.values()].sort((left, right) => left.id.localeCompare(right.id));
  graph.views = orderGraphViews([...views.values()]);
  graph.graphLayer = "final";
  graph.baseGraphVersion = baseGraphVersionFor(baseGraph);
  graph.acceptedPatchCount = operations.length;
  graph.stats = computeStats(graph);
  return graph;
}
