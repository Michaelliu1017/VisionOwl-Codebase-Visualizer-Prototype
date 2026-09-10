import type { GraphView } from "../types";

function viewRank(id: string): number {
  if (id === "project:overview") return 0;
  if (id === "overview") return 1;
  if (id === "flow:request") return 2;
  if (id === "flow:async") return 3;
  if (id === "flow:data") return 4;
  if (id === "flow:external") return 5;
  if (id === "project:cross-repository") return 6;
  return 20;
}

/** Keep bounded architecture views ahead of detailed scanner views. */
export function orderGraphViews(views: GraphView[]): GraphView[] {
  return [...views].sort((left, right) =>
    viewRank(left.id) - viewRank(right.id) || left.id.localeCompare(right.id),
  );
}
