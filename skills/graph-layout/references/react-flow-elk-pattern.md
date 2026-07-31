# React Flow + ELK Pattern

## Contents

1. Data pipeline
2. Container derivation
3. Two-stage ELK layout
4. Edge aggregation
5. Interaction overlay
6. Routing and labels
7. Failure modes

## 1. Data Pipeline

Keep these stages separate:

```text
factual nodes + factual directed edges
  -> validate and normalize
  -> derive visual containers
  -> choose overview aggregate or exact focus endpoints
  -> ELK topology layout
  -> React Flow nodes and edges
  -> selection / hover / animation overlay
```

The final overlay may change opacity, color, labels, and animation. It must not
change graph facts or trigger a new layout.

## 2. Container Derivation

Choose a group in this order:

1. Explicit architecture or ownership metadata.
2. First meaningful path segment after the repository common prefix.
3. Relationship-density community when path grouping produces one dominant
   bucket.

When nodes represent generated architecture layers, use their member
`filePath` values rather than the generated layer path. Evaluate path depth
globally: start at depth one and descend only while one bucket owns more than
about 70 percent of nodes or the result has fewer than two useful groups. Keep
the shallowest balanced result so containers remain understandable.

Merge tiny groups into a clearly labeled fallback only when too many containers
would make the overview unreadable. Do not turn the repository directory itself
into a root module.

## 3. Two-Stage ELK Layout

Use one ELK call for containers and one independent call for each expanded
container. This avoids a large compound layout and keeps expansion predictable.

Suggested defaults for a top-down architecture graph:

```ts
const options = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.spacing.nodeNode": "100",
  "elk.layered.spacing.nodeNodeBetweenLayers": "140",
  "elk.padding": "[top=40,left=40,right=40,bottom=40]",
};
```

For each ELK input node, pass the dimensions used by the rendered component.
After internal layout, compute the container size from member bounds plus its
header and padding. Pass those sizes to the container-level ELK call.

ELK is asynchronous. Cancel stale results when graph input changes and retain
the previous layout while the new one is computing.

Layered layout is not a universal answer for dense cyclic graphs. If a local
subgraph approaches half of all possible directed edges, place its members in a
balanced deterministic grid and let the container-level ELK layout carry the
architectural direction. This avoids extremely tall ranks without falsifying
any relationship.

For up to four containers, keep the layered result whenever directed domain
relationships exist. With five or more large containers, a single layered row
often forces the whole graph below readable scale. Wrap those containers into
at most four columns, seed the order from directed flow scores, and improve it
by minimizing weighted edge length and segment crossings. This is still a
relationship-driven layered grid, not an alphabetical packed fallback.

## 4. Edge Projection And Aggregation

An expanded container is only a visual boundary in focus and path modes. Every
exact edge in those modes must terminate on its factual member endpoint.

In overview mode, exact cross-container edges may be represented by a domain
trunk:

```text
bucket key = directed(sourceContainer, targetContainer)
trunk metadata = count + relation types + original relation IDs
```

Keep exact intra-container edges visible. Selecting a trunk, container, or
member must make the exact cross-container relationships recoverable.

When a container is collapsed, project each hidden endpoint to its container:

```text
displaySource = source is visible ? source : sourceContainer
displayTarget = target is visible ? target : targetContainer
bucket key = directed(displaySource, displayTarget)
```

For each projected bucket, store:

- projected source and target IDs;
- count;
- unique relationship types;
- original relationship IDs.

Direction matters. Keep `A -> B` and `B -> A` as independent facts. The overview
may render reciprocal facts as one static bidirectional edge. Expanding the
container must recover all original directed module edges.

Recommended edge visibility:

| Mode | Exact module edges | Projected aggregate edges |
|---|---|---|
| Overview | intra-container only | all cross-container trunks, labels visible |
| Focus | all visible; selected one-hop emphasized | collapsed endpoints only |
| Path | all visible; active path emphasized | collapsed endpoints only |

Do not discard cross-container facts when building a trunk. Preserve direction,
types, count, and original relationship IDs so focus mode can restore the exact
module edges.

## 5. Interaction Overlay

Compute layout only from structural inputs:

- visible factual nodes;
- visible factual edges;
- container membership;
- expanded or collapsed containers.

Do not include selection, hover, search result, animation frame, or active path
step in layout dependencies.

Apply these states afterward:

- selected node: accent fill and border;
- directly related node: preserve normal contrast;
- unrelated node: optional dimming;
- selected edge: accent color and directional pulse;
- reciprocal edge: static line with arrows on both ends;
- path edge: animated in factual source-to-target direction.

## 6. Routing And Labels

Use the nearest side handles from the positioned source and target. Give
reciprocal directions separate lanes only in focus mode.

Prefer consuming ELK edge sections and bend points when the renderer supports
custom paths. If only ELK node positions are consumed, use a deterministic
smooth-step route with fixed channels.

Show:

- aggregate count/type labels for overview domain trunks;
- direct relationship labels in focus;
- active path labels in path mode.

Candidate label boxes must be checked against node rectangles and already placed
labels. If no collision-free point exists, hide or shorten the label instead of
drawing it through a node.

## 7. Failure Modes

- **Manual grid plus smart edges:** lines still tangle because placement ignores
  topology.
- **Relayout on click:** the user's mental map is destroyed.
- **Expanded container as an endpoint:** hides the real module relationship and
  turns the graph into a directory diagram.
- **Labels on all exact overview edges:** high-degree modules become unreadable
  even when the edge geometry itself is acceptable.
- **Transparent group box above edges:** edges appear inside module cards.
- **Wrong node dimensions:** routes intersect boxes even when ELK reports a
  valid layout.
- **One pulse on a reciprocal edge:** visually claims a false direction.
- **Labels on every edge:** words overlap before the graph itself becomes large.
