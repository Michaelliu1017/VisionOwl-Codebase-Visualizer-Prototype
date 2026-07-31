---
name: graph-layout
description: Design and implement readable directed code, dependency, and architecture graphs with container grouping, ELK layered placement, edge aggregation, and interaction-only visual overlays. Use when graph edges cross or overlap, labels collide with nodes, large React Flow or similar diagrams become unreadable, or a topology view needs clear overview, focus, and path modes.
---

# Graph Layout

Build the graph from facts first, then optimize its presentation. Never invent,
reverse, or delete a factual relationship merely to make the diagram prettier.

## Workflow

1. Normalize node IDs, directed edges, node dimensions, and explicit groups.
2. Derive one visual container per architectural area. For path-derived groups,
   remove the repository common prefix and choose the shallowest directory depth
   that produces a small, balanced set of areas.
3. Use separate topology detail levels. In overview, aggregate cross-container
   relationships into labeled domain trunks. In focus and path modes, restore
   the factual module endpoints.
4. Run a two-stage layout:
   - for a small acyclic domain graph, use ELK layered placement;
   - for five or more large domains, wrap domains into a wide, crossing-aware
     layered grid so the graph remains readable instead of becoming one
     extremely long row;
   - lay out visible members inside each expanded container.
5. Keep exact intra-container edges in overview. Use aggregated cross-container
   trunks to preserve architecture readability, then expose their original
   relation IDs and exact endpoints on selection.
6. Apply selection, hover, search, and animation as a visual overlay without
   recomputing topology.
7. Validate direction, crossings, labels, resize behavior, and large graphs.

Read [references/react-flow-elk-pattern.md](references/react-flow-elk-pattern.md)
before implementing or revising a React Flow graph.

## Required Invariants

- Keep `source`, `target`, and relationship type unchanged.
- Do not create a repository-folder root node unless it is a real modeled entity.
- Prefer explicit architecture groups, then path-based groups, then a
  relationship-density fallback.
- Preserve real repository and independently deployable service boundaries.
  Never merge modules from different detected Git repositories into one visual
  container.
- Never group architecture modules by a synthetic display path such as
  `architecture/<generated-id>`; inspect their real member file paths.
- When one path bucket owns more than roughly 70 percent of modules, descend one
  directory level before accepting the grouping.
- Treat containers as visual boundaries, not business entities.
- In focus and path modes, never terminate an exact edge on an expanded visual
  container. Overview-only aggregate trunks may terminate on containers when
  they retain their source relation IDs.
- Pass measured node and container dimensions to the layout engine.
- Keep layout state separate from transient interaction state.
- Keep reciprocal relations static in the overview; do not imply one-way flow
  with a directional pulse.

## Display Policy

- **Overview:** show containers, their members, exact intra-container edges,
  and one labeled aggregate trunk per cross-container direction. The trunk must
  retain the underlying relation IDs and count.
- **Focus:** show the selected module's exact incoming and outgoing edges.
  Keep unrelated exact structure quiet.
- **Path:** show exact path edges and directional animation. Keep non-path
  relationships dimmed.
- **Expanded container:** preserve both intra-container and cross-container
  module endpoints.
- **Collapsed container:** project hidden member endpoints to the container and
  aggregate duplicates. Preserve the original relationship IDs so expansion
  restores the exact graph.

## Routing And Labels

- Prefer layered layout for directed architecture graphs.
- For the top-level architecture pass, preserve a stable processing direction
  while also respecting the viewport aspect ratio. A long one-row graph that
  forces labels below readable size is a failed layout.
- For five or more large containers, use at most four columns, score candidate
  placement by weighted edge length and crossings, and keep enough row spacing
  for labeled routes.
- Use relationship evidence to rank domains. Collapse reciprocal layout hints
  to one deterministic direction so cycles do not destroy the layer order; this
  affects placement only and must not alter the displayed facts.
- Detect dense cyclic subgraphs. Use a balanced local grid inside their
  container while retaining ELK for the container graph and sparse subgraphs;
  forcing a dense cycle through layered ranks creates unreadable towers.
- Use a compact grid when the layered result would exceed the readable aspect
  ratio. Order and optimize that grid from relationship evidence; never use an
  arbitrary alphabetical packing.
- Enable crossing minimization and reserve enough rank and node spacing.
- Prefer orthogonal or smooth orthogonal routes over arbitrary curves.
- Attach edges to the closest valid side of the real endpoint.
- Always show concise labels for overview aggregate trunks. Show exact labels
  for selected and active-path edges.
- Place labels after node layout and reject positions intersecting nodes or
  existing labels.

## Visual Hierarchy

- A normal container boundary is a quiet structural line, not a selected state.
- Reserve accent fill, strong glow, and high-contrast borders for selection or
  an active path.
- Render code modules as dark neutral glass.
- Render databases, queues, log stores, and external systems with distinct
  icons and a restrained secondary material.
- Keep the primary flow stronger than static imports and supporting relations.

## Validation

Check at least:

- no node or label overlap;
- no edge text inside a node;
- source-to-target direction is visually unambiguous;
- selecting a node does not rearrange the graph;
- bidirectional relationships do not animate as one-way traffic;
- collapsed and expanded containers remain readable;
- the graph still works at narrow and wide viewport sizes.
