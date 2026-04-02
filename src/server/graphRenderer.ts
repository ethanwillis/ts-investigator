import { ok, err, type Result } from 'neverthrow';
import type { DependencyGraph, GraphEdge, GraphNode } from '../graph/types.js';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export interface RendererError {
  readonly kind: 'RendererError';
  readonly code: 'RENDER_FAILED' | 'WASM_UNAVAILABLE' | 'UNKNOWN';
  readonly message: string;
  readonly cause?: unknown;
}

function makeRendererError(
  code: RendererError['code'],
  message: string,
  cause?: unknown,
): RendererError {
  return { kind: 'RendererError', code, message, cause };
}

// ---------------------------------------------------------------------------
// Renderer interface (Strategy Pattern — swappable rendering backend)
// ---------------------------------------------------------------------------

export interface IGraphRenderer {
  render(graph: DependencyGraph): Promise<Result<string, RendererError>>;
}

// ---------------------------------------------------------------------------
// Color / style lookup maps
// ---------------------------------------------------------------------------

const NODE_COLORS: Record<GraphNode['kind'], string> = {
  function: '#4A90D9',
  class: '#E67E22',
  interface: '#27AE60',
  typeAlias: '#8E44AD',
  module: '#95A5A6',
};

const NODE_BORDER_COLORS: Record<GraphNode['kind'], string> = {
  function: '#2d6ca8',
  class: '#b85e1a',
  interface: '#1a7a40',
  typeAlias: '#6a2f80',
  module: '#6a7a80',
};

const EDGE_STYLES: Record<GraphEdge['kind'], string> = {
  call: 'solid',
  import: 'dashed',
  inherits: 'bold',
  references: 'dotted',
};

const EDGE_COLORS: Record<GraphEdge['kind'], string> = {
  call: '#4A90D9',
  import: '#5a5a8a',
  inherits: '#27AE60',
  references: '#8E44AD',
};

// ---------------------------------------------------------------------------
// Grouped edge type
// ---------------------------------------------------------------------------

export interface EdgeGroup {
  readonly from: string;
  readonly to: string;
  readonly edges: readonly GraphEdge[];
  readonly dominantKind: GraphEdge['kind'];
}

/**
 * Groups all edges in the graph by their (from, to) pair. Parallel edges are
 * collapsed into a single `EdgeGroup`. The dominant kind (most frequent) drives
 * the visual style; a count label is shown when more than one edge exists.
 */
export function groupEdges(graph: DependencyGraph): readonly EdgeGroup[] {
  const map = new Map<string, GraphEdge[]>();

  for (const edge of graph.edges) {
    const key = `${edge.from}\x00${edge.to}`;
    const existing = map.get(key);
    if (existing !== undefined) {
      existing.push(edge);
    } else {
      map.set(key, [edge]);
    }
  }

  const groups: EdgeGroup[] = [];

  for (const [key, edges] of map) {
    const sep = key.indexOf('\x00');
    const from = key.slice(0, sep);
    const to = key.slice(sep + 1);

    const kindCount = new Map<GraphEdge['kind'], number>();
    for (const e of edges) {
      kindCount.set(e.kind, (kindCount.get(e.kind) ?? 0) + 1);
    }
    let dominantKind: GraphEdge['kind'] = edges[0]?.kind ?? 'references';
    let maxCount = 0;
    for (const [kind, count] of kindCount) {
      if (count > maxCount) {
        maxCount = count;
        dominantKind = kind;
      }
    }

    groups.push({ from, to, edges, dominantKind });
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Connected-component analysis
// ---------------------------------------------------------------------------

export interface ClusterInfo {
  /** Stable id used as the DOT subgraph name, e.g. "ep_0", "cmp_1", "orphans". */
  readonly id: string;
  /** Human-readable cluster label shown inside the box. */
  readonly label: string;
  /** Whether this cluster contains at least one entrypoint node. */
  readonly hasEntrypoint: boolean;
  /** Whether this cluster is the orphan cluster (nodes with zero edges). */
  readonly isOrphan: boolean;
  /** Node ids belonging to this cluster. */
  readonly nodeIds: ReadonlySet<string>;
}

export interface ComponentResult {
  readonly clusters: readonly ClusterInfo[];
  /** Quick lookup: nodeId → cluster id. */
  readonly nodeClusterMap: ReadonlyMap<string, string>;
}

/**
 * Computes the connected components of the graph (treating all edges as
 * undirected) and returns a set of labelled clusters suitable for DOT
 * `subgraph cluster_*` output.
 *
 * Ordering guarantees:
 * 1. Entrypoint-containing clusters come first.
 * 2. Among same type, larger clusters (by node count) come first.
 * 3. The orphan cluster (nodes with no edges) is always last.
 */
export function computeComponents(graph: DependencyGraph): ComponentResult {
  // ── Build undirected adjacency list ────────────────────────────────────
  const adj = new Map<string, Set<string>>();
  for (const nodeId of graph.nodes.keys()) {
    adj.set(nodeId, new Set<string>());
  }

  const referencedIds = new Set<string>();
  for (const edge of graph.edges) {
    adj.get(edge.from)?.add(edge.to);
    adj.get(edge.to)?.add(edge.from);
    referencedIds.add(edge.from);
    referencedIds.add(edge.to);
  }

  // ── Identify truly isolated nodes (no edges) ───────────────────────────
  const orphanIds = new Set<string>();
  for (const nodeId of graph.nodes.keys()) {
    if (!referencedIds.has(nodeId)) {
      orphanIds.add(nodeId);
    }
  }

  // ── Identify entrypoint nodes ──────────────────────────────────────────
  const entrypointNodeIds = new Set<string>();
  for (const [nodeId, node] of graph.nodes) {
    const absPath = node.filePath.startsWith('/')
      ? node.filePath
      : `${graph.projectRoot}/${node.filePath}`;
    if (graph.entrypoints.some((ep) => ep === absPath || ep === node.filePath)) {
      entrypointNodeIds.add(nodeId);
    }
  }

  // ── BFS to find connected components (exclude orphans) ─────────────────
  const visited = new Set<string>();
  const rawComponents: Array<{ nodeIds: Set<string>; hasEntrypoint: boolean }> = [];

  for (const nodeId of graph.nodes.keys()) {
    if (orphanIds.has(nodeId) || visited.has(nodeId)) continue;

    const component = new Set<string>();
    let hasEntrypoint = false;
    const queue: string[] = [nodeId];
    visited.add(nodeId);

    while (queue.length > 0) {
      const current = queue.shift()!;
      component.add(current);
      if (entrypointNodeIds.has(current)) hasEntrypoint = true;

      for (const neighbor of adj.get(current) ?? []) {
        if (!visited.has(neighbor) && !orphanIds.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    rawComponents.push({ nodeIds: component, hasEntrypoint });
  }

  // ── Sort: entrypoint clusters first, then by size ─────────────────────
  rawComponents.sort((a, b) => {
    if (a.hasEntrypoint !== b.hasEntrypoint) return a.hasEntrypoint ? -1 : 1;
    return b.nodeIds.size - a.nodeIds.size;
  });

  // ── Build named ClusterInfo list ───────────────────────────────────────
  const clusters: ClusterInfo[] = [];
  const nodeClusterMap = new Map<string, string>();

  let epIdx = 0;
  let cmpIdx = 0;

  for (const rc of rawComponents) {
    let id: string;
    let label: string;

    if (rc.hasEntrypoint) {
      id = `ep_${epIdx}`;
      label = epIdx === 0 ? 'Entrypoint' : `Entrypoint ${epIdx + 1}`;
      epIdx++;
    } else {
      id = `cmp_${cmpIdx}`;
      label = `Component ${cmpIdx + 1}`;
      cmpIdx++;
    }

    for (const nodeId of rc.nodeIds) {
      nodeClusterMap.set(nodeId, id);
    }

    clusters.push({
      id,
      label,
      hasEntrypoint: rc.hasEntrypoint,
      isOrphan: false,
      nodeIds: rc.nodeIds,
    });
  }

  // ── Orphan cluster (always last) ───────────────────────────────────────
  if (orphanIds.size > 0) {
    const id = 'orphans';
    for (const nodeId of orphanIds) {
      nodeClusterMap.set(nodeId, id);
    }
    clusters.push({
      id,
      label: 'Orphaned',
      hasEntrypoint: false,
      isOrphan: true,
      nodeIds: orphanIds,
    });
  }

  return { clusters, nodeClusterMap };
}

// ---------------------------------------------------------------------------
// Graph filtering helper
// ---------------------------------------------------------------------------

/**
 * Returns a new `DependencyGraph` containing only the nodes in `nodeIds` and
 * edges where both `from` and `to` are present in that set.
 *
 * Used by the investigate server to render a partial graph (e.g. one or more
 * selected clusters) without re-running the full analyzer.
 */
export function filterGraphToNodes(
  graph: DependencyGraph,
  nodeIds: ReadonlySet<string>,
): DependencyGraph {
  const filteredNodes = new Map<string, GraphNode>(
    Array.from(graph.nodes.entries()).filter(([id]) => nodeIds.has(id)),
  );
  const filteredEdges = graph.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));
  // Only keep entrypoints that still have a corresponding node in the filtered set
  const filteredEntrypoints = graph.entrypoints.filter((ep) => {
    for (const [, node] of filteredNodes) {
      const absPath = node.filePath.startsWith('/')
        ? node.filePath
        : `${graph.projectRoot}/${node.filePath}`;
      if (ep === absPath || ep === node.filePath) return true;
    }
    return false;
  });

  return {
    version: graph.version,
    generatedAt: graph.generatedAt,
    projectRoot: graph.projectRoot,
    entrypoints: filteredEntrypoints,
    nodes: filteredNodes,
    edges: filteredEdges,
  };
}

// ---------------------------------------------------------------------------
// Topological layer computation (Kahn's algorithm)
// ---------------------------------------------------------------------------

/**
 * Assigns each node in a cluster to a topological depth layer.
 *
 * Uses Kahn's longest-path algorithm on the intra-cluster subgraph so that:
 *   - Source nodes (no incoming intra-cluster edges) land on layer 0.
 *   - Every other node lands on the deepest layer reachable from any source.
 *   - Nodes involved in cycles (in-degree never reaches 0) are assigned to
 *     the layer after the highest resolved layer.
 *
 * The resulting layer map drives `rank=same` subgraphs inside each cluster,
 * giving Graphviz far better crossing-minimisation starting points.
 */
function computeLayersForCluster(
  clusterNodeIds: ReadonlySet<string>,
  graph: DependencyGraph,
): ReadonlyMap<string, number> {
  const inDegree = new Map<string, number>();
  const successors = new Map<string, string[]>();

  for (const nid of clusterNodeIds) {
    inDegree.set(nid, 0);
    successors.set(nid, []);
  }

  for (const edge of graph.edges) {
    // Self-loops contribute nothing to the layer structure.
    if (clusterNodeIds.has(edge.from) && clusterNodeIds.has(edge.to) && edge.from !== edge.to) {
      inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
      successors.get(edge.from)?.push(edge.to);
    }
  }

  const layer = new Map<string, number>();
  const remaining = new Map(inDegree);
  const queue: string[] = [];

  for (const [nid, deg] of remaining) {
    if (deg === 0) {
      queue.push(nid);
      layer.set(nid, 0);
    }
  }

  let qi = 0;
  while (qi < queue.length) {
    const nid = queue[qi++]!;
    const cur = layer.get(nid) ?? 0;

    for (const succ of successors.get(nid) ?? []) {
      const newDeg = (remaining.get(succ) ?? 1) - 1;
      remaining.set(succ, newDeg);
      // Longest-path: push succ as deep as possible.
      layer.set(succ, Math.max(layer.get(succ) ?? 0, cur + 1));
      if (newDeg <= 0) queue.push(succ);
    }
  }

  // Any node not yet assigned is part of a cycle — place it one layer beyond
  // the deepest resolved layer so it still appears roughly in the right zone.
  const maxLayer = layer.size > 0 ? Math.max(...layer.values()) : 0;
  for (const nid of clusterNodeIds) {
    if (!layer.has(nid)) layer.set(nid, maxLayer + 1);
  }

  return layer;
}

// ---------------------------------------------------------------------------
// Edge weight table — higher weight = Graphviz prefers shorter, straighter edges
// ---------------------------------------------------------------------------

const EDGE_WEIGHTS: Record<GraphEdge['kind'], number> = {
  call: 4, // Call hierarchy is the primary structure — draw straight.
  inherits: 3, // Inheritance is strongly hierarchical.
  import: 2, // Import dependencies are important but more lateral.
  references: 1, // Type references are secondary — allow more routing freedom.
};

// ---------------------------------------------------------------------------
// DOT string builder — exported so it can be unit-tested without WASM
// ---------------------------------------------------------------------------

/**
 * Escapes a string for safe inclusion inside a DOT double-quoted string.
 * Graphviz interprets \n as a centred newline in labels.
 */
function escapeDotString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '').replace(/\n/g, '\\n');
}

/**
 * Emits the DOT attribute list for a single graph node.
 */
function emitNodeDot(nodeId: string, node: GraphNode, isEntrypoint: boolean): string {
  const fillColor = NODE_COLORS[node.kind];
  const borderColor = NODE_BORDER_COLORS[node.kind];
  const escapedId = escapeDotString(nodeId);
  const label = `${escapeDotString(node.kind)}\\n${escapeDotString(node.name)}`;
  const penWidth = isEntrypoint ? '2.5' : '1.5';

  return (
    `    "${escapedId}" [` +
    `id="${escapedId}", ` +
    `label="${label}", ` +
    `fillcolor="${fillColor}", ` +
    `color="${borderColor}", ` +
    `style="filled,rounded", ` +
    `shape="box", ` +
    `penwidth=${penWidth}` +
    `];`
  );
}

/**
 * Builds a DOT language string from a `DependencyGraph`.
 *
 * Key behaviours:
 * - Nodes are grouped into Graphviz `subgraph cluster_*` boxes based on their
 *   connected component:
 *     • Entrypoint clusters (components containing at least one entrypoint
 *       node) appear first and have a highlighted border.
 *     • Disconnected clusters (no entrypoint) appear next.
 *     • The orphan cluster (nodes with zero edges) appears last with a
 *       dimmed dashed border.
 * - Parallel edges between the same node pair are deduplicated into one DOT
 *   edge with a numeric count label (e.g. "×3").
 *
 * Exported separately so it can be unit-tested without the WASM runtime.
 */
export function buildDotString(graph: DependencyGraph): string {
  const lines: string[] = [];

  // ── Graph-level attributes ─────────────────────────────────────────────
  // rankdir=TB  — callers appear above callees; the most natural reading
  //               direction for a call graph.  With LR every "level" of the
  //               call hierarchy stacks nodes into a tall column, producing
  //               long cross-edges that the eye has to track horizontally.
  //               TB spreads each level across a wide row instead.
  //
  // concentrate  — Merges edges that share a common source or target into a
  //               "bundle" before they diverge, slashing the number of
  //               separately-drawn lines on screen.
  //
  // mclimit=4   — Increase the crossing-minimisation iteration budget
  //               (default 1.0) so dot tries harder to untangle nodes within
  //               each rank.
  //
  // splines=ortho — Routes every edge along horizontal/vertical segments.
  //               Crossings are now always right-angled, making them far
  //               easier to visually resolve than diagonal crossings.
  //
  // newrank=true — Allows rank constraints inside clusters to interact
  //               correctly with compound=true cluster layout.
  lines.push('digraph G {');
  lines.push('  rankdir=TB;');
  lines.push('  bgcolor="#1a1a2e";');
  lines.push('  compound=true;');
  lines.push('  concentrate=true;');
  lines.push('  mclimit=4;');
  lines.push('  splines=ortho;');
  lines.push('  pad=0.6;');
  lines.push('  nodesep=0.5;');
  lines.push('  ranksep=0.9;');
  lines.push('  newrank=true;');
  lines.push(
    '  node [fontname="Helvetica,Arial,sans-serif", fontcolor="#ffffff",' +
      ' fontsize=11, margin="0.25,0.12", penwidth=1.5];',
  );
  lines.push(
    '  edge [fontname="Helvetica,Arial,sans-serif", fontcolor="#aaaacc",' +
      ' fontsize=9, color="#5a5a8a", arrowsize=0.7];',
  );
  lines.push('');

  // ── Compute components ────────────────────────────────────────────────
  const { clusters } = computeComponents(graph);

  // ── Identify entrypoint node ids for thick-border rendering ───────────
  const entrypointNodeIds = new Set<string>();
  for (const [nodeId, node] of graph.nodes) {
    const absPath = node.filePath.startsWith('/')
      ? node.filePath
      : `${graph.projectRoot}/${node.filePath}`;
    if (graph.entrypoints.some((ep) => ep === absPath || ep === node.filePath)) {
      entrypointNodeIds.add(nodeId);
    }
  }

  // ── Emit one subgraph cluster per component ────────────────────────────
  for (const cluster of clusters) {
    const escapedClusterId = escapeDotString(cluster.id);
    const escapedLabel = escapeDotString(cluster.label);

    // Visual style varies by cluster type
    let clusterAttrs: string;
    if (cluster.isOrphan) {
      clusterAttrs = [
        `  label="${escapedLabel}";`,
        '  style="rounded,dashed";',
        '  color="#2a2a40";',
        '  bgcolor="#0c0c1c";',
        '  fontcolor="#3a3a6a";',
        '  fontname="Helvetica,Arial,sans-serif";',
        '  fontsize=11;',
        '  penwidth=1.0;',
        '  margin=18;',
      ].join('\n');
    } else if (cluster.hasEntrypoint) {
      clusterAttrs = [
        `  label="${escapedLabel}";`,
        '  style="rounded,filled";',
        '  color="#3d3d7a";',
        '  bgcolor="#0e0e24";',
        '  fontcolor="#818cf8";',
        '  fontname="Helvetica-Bold,Arial,sans-serif";',
        '  fontsize=11;',
        '  penwidth=1.8;',
        '  margin=18;',
      ].join('\n');
    } else {
      clusterAttrs = [
        `  label="${escapedLabel}";`,
        '  style="rounded,dashed";',
        '  color="#1e2a40";',
        '  bgcolor="#0a0e1a";',
        '  fontcolor="#475569";',
        '  fontname="Helvetica,Arial,sans-serif";',
        '  fontsize=11;',
        '  penwidth=1.0;',
        '  margin=18;',
      ].join('\n');
    }

    lines.push(`  subgraph cluster_${escapedClusterId} {`);
    for (const attrLine of clusterAttrs.split('\n')) {
      lines.push(`  ${attrLine}`);
    }
    lines.push('');

    if (cluster.isOrphan) {
      // Orphaned nodes have no intra-cluster edges; emit them flat.
      for (const nodeId of cluster.nodeIds) {
        const node = graph.nodes.get(nodeId);
        if (node !== undefined) lines.push(emitNodeDot(nodeId, node, false));
      }
    } else {
      // ── Topological layer grouping ────────────────────────────────────
      // 1. Compute longest-path layer for every node in the cluster.
      // 2. Collect nodes into per-layer buckets (sorted ascending).
      // 3. Emit a `rank=same` subgraph for each layer with ≥ 2 nodes —
      //    this tells dot's crossing-minimiser which nodes must share the
      //    same horizontal band, dramatically reducing crossing counts.
      // 4. Emit the actual node attribute lines in the same layer order so
      //    the crossing minimiser gets a good initial permutation to refine.
      const layerMap = computeLayersForCluster(cluster.nodeIds, graph);

      const layerBuckets = new Map<number, string[]>();
      for (const [nid, depth] of layerMap) {
        const bucket = layerBuckets.get(depth) ?? [];
        bucket.push(nid);
        layerBuckets.set(depth, bucket);
      }

      const sortedLayers = Array.from(layerBuckets.entries()).sort(([a], [b]) => a - b);

      // Emit rank=same groups
      for (const [, nodeIds] of sortedLayers) {
        if (nodeIds.length > 1) {
          lines.push('    { rank=same;');
          for (const nid of nodeIds) {
            lines.push(`      "${escapeDotString(nid)}";`);
          }
          lines.push('    }');
        }
      }
      lines.push('');

      // Emit node definitions in topological order
      for (const [, nodeIds] of sortedLayers) {
        for (const nid of nodeIds) {
          const node = graph.nodes.get(nid);
          if (node !== undefined) lines.push(emitNodeDot(nid, node, entrypointNodeIds.has(nid)));
        }
      }
    }

    lines.push('  }');
    lines.push('');
  }

  // ── Edges (deduplicated, emitted at graph level) ───────────────────────
  const edgeGroups = groupEdges(graph);

  for (const group of edgeGroups) {
    const escapedFrom = escapeDotString(group.from);
    const escapedTo = escapeDotString(group.to);
    const style = EDGE_STYLES[group.dominantKind];
    const color = EDGE_COLORS[group.dominantKind];
    const count = group.edges.length;

    // base64url avoids +, / and = — safe in HTML ids and CSS selectors.
    // The client-side edgeGroupData uses the same encoding so ids match.
    const edgeKey = `${group.from}\x00${group.to}`;
    const edgeId = escapeDotString(Buffer.from(edgeKey).toString('base64url'));

    let labelAttr: string;
    if (count === 1) {
      const edge = group.edges[0];
      if (edge !== undefined && edge.kind === 'import' && edge.importedNames.length > 0) {
        const preview = edge.importedNames
          .slice(0, 3)
          .map((n) => escapeDotString(n))
          .join(', ');
        const suffix = edge.importedNames.length > 3 ? '…' : '';
        labelAttr = `label="${preview}${suffix}", fontsize=8, `;
      } else {
        labelAttr = '';
      }
    } else {
      labelAttr = `label="×${count}", fontcolor="#f0c040", fontsize=10, fontname="Helvetica-Bold", `;
    }

    const edgeWeight = EDGE_WEIGHTS[group.dominantKind];
    lines.push(
      `  "${escapedFrom}" -> "${escapedTo}" [` +
        `id="${edgeId}", ` +
        `weight=${edgeWeight}, ` +
        `${labelAttr}` +
        `style="${style}", ` +
        `color="${color}", ` +
        `penwidth=${count > 1 ? '2.0' : '1.2'}` +
        `];`,
    );
  }

  lines.push('}');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// GraphvizRenderer — WASM-backed implementation of IGraphRenderer
// ---------------------------------------------------------------------------

export class GraphvizRenderer implements IGraphRenderer {
  async render(graph: DependencyGraph): Promise<Result<string, RendererError>> {
    let Graphviz: { load(): Promise<{ dot(src: string, fmt?: string): string }> };

    try {
      const mod = (await import('@hpcc-js/wasm-graphviz')) as {
        Graphviz: { load(): Promise<{ dot(src: string, fmt?: string): string }> };
      };
      Graphviz = mod.Graphviz;
    } catch (cause) {
      return err(
        makeRendererError(
          'WASM_UNAVAILABLE',
          'Failed to load the Graphviz WASM module. ' +
            'Ensure @hpcc-js/wasm-graphviz is installed in node_modules.',
          cause,
        ),
      );
    }

    let graphviz: { dot(src: string, fmt?: string): string };

    try {
      graphviz = await Graphviz.load();
    } catch (cause) {
      return err(
        makeRendererError(
          'WASM_UNAVAILABLE',
          'Graphviz WASM module loaded but failed to initialise.',
          cause,
        ),
      );
    }

    try {
      const dotString = buildDotString(graph);
      const svg = graphviz.dot(dotString, 'svg');
      return ok(svg);
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : typeof cause === 'string'
            ? cause
            : 'Unknown render error';
      return err(makeRendererError('RENDER_FAILED', `Graphviz render failed: ${message}`, cause));
    }
  }
}
