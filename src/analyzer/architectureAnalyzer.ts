import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';
import type {
  DependencyGraph,
  GraphNode,
  GraphEdge,
  FunctionNode,
  TypeInfo,
} from '../graph/types.js';

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export interface FanMetrics {
  readonly fanIn: number;
  readonly fanOut: number;
}

export interface DeadCodeEntry {
  readonly nodeId: string;
  readonly kind: GraphNode['kind'];
  readonly name: string;
  readonly filePath: string;
  readonly line?: number;
  readonly reason: string;
}

export interface CycleEntry {
  /** Subset of node ids forming the cycle (capped at 10 for readability). */
  readonly nodeIds: readonly string[];
  readonly nodeNames: readonly string[];
  /** Deduplicated list of source files involved. */
  readonly filePaths: readonly string[];
  readonly edgeKind: 'import' | 'call';
  /** Total cycle length (may exceed nodeIds.length if capped). */
  readonly length: number;
}

export interface GodNodeEntry {
  readonly nodeId: string;
  readonly name: string;
  readonly kind: GraphNode['kind'];
  readonly filePath: string;
  readonly line?: number;
  readonly fanIn: number;
  readonly fanOut: number;
  readonly callerNames: readonly string[];
  readonly calleeNames: readonly string[];
  readonly severity: 'high' | 'medium';
}

export interface DuplicateGroup {
  readonly signature: string;
  readonly matchType: 'identical-name' | 'identical-parameters' | 'identical-body';
  readonly nodes: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly filePath: string;
    readonly line?: number;
  }>;
  readonly description: string;
}

export interface ModuleCouplingEntry {
  readonly moduleId: string;
  readonly name: string;
  readonly filePath: string;
  /** Afferent coupling — how many modules depend on this one. */
  readonly ca: number;
  /** Efferent coupling — how many modules this one depends on. */
  readonly ce: number;
  /** Instability: Ce / (Ca + Ce). 0 = maximally stable, 1 = maximally unstable. */
  readonly instability: number;
  readonly verdict: 'stable-abstract' | 'stable-concrete' | 'balanced' | 'unstable' | 'isolated';
  readonly dependents: readonly string[];
  readonly dependencies: readonly string[];
}

export interface HubNodeEntry {
  readonly nodeId: string;
  readonly name: string;
  readonly filePath: string;
  readonly importedByCount: number;
  readonly importedByNames: readonly string[];
}

export interface ArchitectureReport {
  readonly projectRoot: string;
  readonly generatedAt: string;
  readonly metrics: {
    readonly totalNodes: number;
    readonly totalEdges: number;
    readonly functionCount: number;
    readonly classCount: number;
    readonly moduleCount: number;
    readonly typeCount: number;
    readonly callEdges: number;
    readonly importEdges: number;
    readonly entrypointCount: number;
    readonly reachableCount: number;
    readonly reachabilityRatio: number;
  };
  readonly deadCode: readonly DeadCodeEntry[];
  readonly importCycles: readonly CycleEntry[];
  readonly callCycles: readonly CycleEntry[];
  readonly godNodes: readonly GodNodeEntry[];
  readonly duplicates: readonly DuplicateGroup[];
  readonly moduleCoupling: readonly ModuleCouplingEntry[];
  readonly hubNodes: readonly HubNodeEntry[];
}

export interface AnalysisOptions {
  readonly includeDead?: boolean;
  readonly includeCycles?: boolean;
  readonly includeGodNodes?: boolean;
  readonly includeDuplicates?: boolean;
  readonly includeCoupling?: boolean;
  /**
   * Fan-out threshold for god-node detection.
   * Functions calling >= this many others are flagged.
   * @default 10
   */
  readonly fanOutThreshold?: number;
  /**
   * Fan-in threshold for god-node detection.
   * Nodes depended on by >= this many callers are flagged.
   * @default 12
   */
  readonly fanInThreshold?: number;
  /**
   * Minimum number of nodes a cycle must contain before it is reported.
   * Set to 3 to suppress 2-node mutual recursion cycles, which are often
   * intentional (e.g. two functions that delegate to each other).
   * @default 2  (all cycles shown)
   */
  readonly minCycleLength?: number;
}

export interface PromptOptions {
  /** Source lines to show above/below each flagged node's declaration. */
  readonly contextLines?: number;
  /** Cap on dead-code entries written to the prompt. */
  readonly maxDeadCodeEntries?: number;
  /** Cap on cycles written to the prompt. */
  readonly maxCycles?: number;
  /** Cap on god-node entries written to the prompt. */
  readonly maxGodNodes?: number;
  /** Cap on duplicate groups written to the prompt. */
  readonly maxDuplicateGroups?: number;
}

// ---------------------------------------------------------------------------
// TypeInfo → canonical string (for signature comparison)
// ---------------------------------------------------------------------------

function canonicalType(ti: TypeInfo, depth = 0): string {
  if (depth > 4) return '…';
  switch (ti.kind) {
    case 'primitive':
      return ti.name;
    case 'literal':
      return JSON.stringify(ti.value);
    case 'array':
      return `${canonicalType(ti.elementType, depth + 1)}[]`;
    case 'tuple':
      return `[${ti.elements.map((e) => canonicalType(e, depth + 1)).join(', ')}]`;
    case 'union':
      return ti.members
        .map((m) => canonicalType(m, depth + 1))
        .sort()
        .join(' | ');
    case 'intersection':
      return ti.members
        .map((m) => canonicalType(m, depth + 1))
        .sort()
        .join(' & ');
    case 'object': {
      const props = [...ti.properties]
        .map((p) => `${p.name}${p.isOptional ? '?' : ''}: ${canonicalType(p.typeInfo, depth + 1)}`)
        .sort()
        .join('; ');
      return `{ ${props} }`;
    }
    case 'reference': {
      const args =
        ti.typeArguments.length > 0
          ? `<${ti.typeArguments.map((a) => canonicalType(a, depth + 1)).join(', ')}>`
          : '';
      return `${ti.name}${args}`;
    }
    case 'function': {
      const params = ti.parameters
        .map((p) => `${p.name}: ${canonicalType(p.typeInfo, depth + 1)}`)
        .join(', ');
      return `(${params}) => ${canonicalType(ti.returnType, depth + 1)}`;
    }
    case 'unknown':
      return ti.raw;
  }
}

function paramSignature(fn: FunctionNode): string {
  return fn.parameters.map((p) => canonicalType(p.typeInfo)).join(', ');
}

// ---------------------------------------------------------------------------
// Reachability analysis (BFS from entrypoints through all edge kinds)
// ---------------------------------------------------------------------------

function computeReachable(graph: DependencyGraph): ReadonlySet<string> {
  const reachable = new Set<string>();

  // Seed set: every node whose file path matches a known entrypoint
  const epAbsPaths = new Set(
    graph.entrypoints.map((ep) => (path.isAbsolute(ep) ? ep : path.join(graph.projectRoot, ep))),
  );

  const seeds: string[] = [];
  for (const [nodeId, node] of graph.nodes) {
    const abs = path.isAbsolute(node.filePath)
      ? node.filePath
      : path.join(graph.projectRoot, node.filePath);
    if (
      epAbsPaths.has(abs) ||
      epAbsPaths.has(node.filePath) ||
      graph.entrypoints.includes(node.filePath)
    ) {
      seeds.push(nodeId);
    }
  }

  // BFS through every edge type
  const queue: string[] = [...seeds];
  let qi = 0;
  while (qi < queue.length) {
    const id = queue[qi++];
    if (id === undefined || reachable.has(id)) continue;
    reachable.add(id);
    for (const edge of graph.edges) {
      if (edge.from === id && !reachable.has(edge.to)) {
        queue.push(edge.to);
      }
    }
  }

  return reachable;
}

// ---------------------------------------------------------------------------
// Iterative Tarjan's SCC
// (Recursive Tarjan's overflows the call stack on large graphs.)
// ---------------------------------------------------------------------------

function tarjanSCC(
  nodeIds: readonly string[],
  getSuccessors: (id: string) => readonly string[],
): readonly (readonly string[])[] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: Array<readonly string[]> = [];
  let counter = 0;

  // Each work frame tracks the node and an iterator over its successors.
  interface Frame {
    v: string;
    iter: Iterator<string>;
  }
  const work: Frame[] = [];

  const push = (v: string): void => {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    work.push({ v, iter: (getSuccessors(v) as Iterable<string>)[Symbol.iterator]() });
  };

  for (const nodeId of nodeIds) {
    if (index.has(nodeId)) continue;
    push(nodeId);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame === undefined) break;

      const next = frame.iter.next();

      if (!next.done) {
        const w = next.value;
        if (!index.has(w)) {
          push(w);
        } else if (onStack.has(w)) {
          const vLow = lowlink.get(frame.v);
          const wIdx = index.get(w);
          if (vLow !== undefined && wIdx !== undefined) {
            lowlink.set(frame.v, Math.min(vLow, wIdx));
          }
        }
      } else {
        work.pop();

        const parentFrame = work[work.length - 1];
        if (parentFrame !== undefined) {
          const parentLow = lowlink.get(parentFrame.v);
          const childLow = lowlink.get(frame.v);
          if (parentLow !== undefined && childLow !== undefined) {
            lowlink.set(parentFrame.v, Math.min(parentLow, childLow));
          }
        }

        if (lowlink.get(frame.v) === index.get(frame.v)) {
          const scc: string[] = [];
          let w: string | undefined;
          do {
            w = stack.pop();
            if (w !== undefined) {
              onStack.delete(w);
              scc.push(w);
            }
          } while (w !== undefined && w !== frame.v);
          if (scc.length > 1) sccs.push(scc);
        }
      }
    }
  }

  return sccs;
}

// ---------------------------------------------------------------------------
// Fan-in / fan-out computation
// ---------------------------------------------------------------------------

function computeFanMetrics(graph: DependencyGraph): ReadonlyMap<string, FanMetrics> {
  const result = new Map<string, { fanIn: number; fanOut: number }>();

  for (const nodeId of graph.nodes.keys()) {
    result.set(nodeId, { fanIn: 0, fanOut: 0 });
  }

  for (const edge of graph.edges) {
    const from = result.get(edge.from);
    const to = result.get(edge.to);
    if (from !== undefined) from.fanOut++;
    if (to !== undefined) to.fanIn++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Cycle detection (import cycles + call cycles separately)
// ---------------------------------------------------------------------------

function detectCycles(
  graph: DependencyGraph,
  minCycleLength: number,
): {
  importCycles: readonly CycleEntry[];
  callCycles: readonly CycleEntry[];
} {
  const allNodeIds = Array.from(graph.nodes.keys());

  // Build per-kind successor maps
  const importSucc = new Map<string, string[]>();
  const callSucc = new Map<string, string[]>();

  for (const edge of graph.edges) {
    if (edge.kind === 'import') {
      const list = importSucc.get(edge.from) ?? [];
      list.push(edge.to);
      importSucc.set(edge.from, list);
    } else if (edge.kind === 'call') {
      const list = callSucc.get(edge.from) ?? [];
      list.push(edge.to);
      callSucc.set(edge.from, list);
    }
  }

  const toEntry = (scc: readonly string[], kind: CycleEntry['edgeKind']): CycleEntry => {
    const capped = scc.slice(0, 10);
    return {
      nodeIds: capped,
      nodeNames: capped.map((id) => graph.nodes.get(id)?.name ?? id),
      filePaths: [...new Set(capped.map((id) => graph.nodes.get(id)?.filePath ?? ''))].filter(
        Boolean,
      ),
      edgeKind: kind,
      length: scc.length,
    };
  };

  const importSCCs = tarjanSCC(allNodeIds, (id) => importSucc.get(id) ?? []);
  const callSCCs = tarjanSCC(allNodeIds, (id) => callSucc.get(id) ?? []);

  return {
    importCycles: importSCCs
      .filter((scc) => scc.length >= minCycleLength)
      .map((scc) => toEntry(scc, 'import')),
    callCycles: callSCCs
      .filter((scc) => scc.length >= minCycleLength)
      .map((scc) => toEntry(scc, 'call')),
  };
}

// ---------------------------------------------------------------------------
// Module-level coupling metrics (Martin's Instability)
// ---------------------------------------------------------------------------

function computeModuleCoupling(graph: DependencyGraph): readonly ModuleCouplingEntry[] {
  const modules = Array.from(graph.nodes.values()).filter((n) => n.kind === 'module');

  // Map: filePath -> moduleNode
  const fileToModule = new Map<string, (typeof modules)[number]>();
  for (const m of modules) {
    fileToModule.set(m.filePath, m);
  }

  // Ca: modules that import this one  |  Ce: modules this one imports
  const ca = new Map<string, Set<string>>();
  const ce = new Map<string, Set<string>>();
  for (const m of modules) {
    ca.set(m.id, new Set());
    ce.set(m.id, new Set());
  }

  for (const edge of graph.edges) {
    if (edge.kind !== 'import') continue;

    const fromNode = graph.nodes.get(edge.from);
    const toNode = graph.nodes.get(edge.to);
    if (fromNode === undefined || toNode === undefined) continue;

    const fromMod = fileToModule.get(fromNode.filePath);
    const toMod = fileToModule.get(toNode.filePath);
    if (fromMod === undefined || toMod === undefined) continue;
    if (fromMod.id === toMod.id) continue;

    ce.get(fromMod.id)?.add(toMod.id);
    ca.get(toMod.id)?.add(fromMod.id);
  }

  return modules
    .map((m): ModuleCouplingEntry => {
      const caSet = ca.get(m.id) ?? new Set<string>();
      const ceSet = ce.get(m.id) ?? new Set<string>();
      const caCount = caSet.size;
      const ceCount = ceSet.size;
      const total = caCount + ceCount;
      const instability = total === 0 ? 0 : Math.round((ceCount / total) * 100) / 100;

      // Classify: is this module primarily abstract types?
      const nodesInModule = Array.from(graph.nodes.values()).filter(
        (n) => n.filePath === m.filePath,
      );
      const abstractCount = nodesInModule.filter(
        (n) => n.kind === 'interface' || n.kind === 'typeAlias',
      ).length;
      const abstractRatio = nodesInModule.length > 0 ? abstractCount / nodesInModule.length : 0;

      let verdict: ModuleCouplingEntry['verdict'];
      if (total === 0) {
        verdict = 'isolated';
      } else if (instability <= 0.2) {
        verdict = abstractRatio >= 0.6 ? 'stable-abstract' : 'stable-concrete';
      } else if (instability >= 0.75) {
        verdict = 'unstable';
      } else {
        verdict = 'balanced';
      }

      return {
        moduleId: m.id,
        name: m.name,
        filePath: m.filePath,
        ca: caCount,
        ce: ceCount,
        instability,
        verdict,
        dependents: Array.from(caSet)
          .map((id) => graph.nodes.get(id)?.name ?? id)
          .slice(0, 8),
        dependencies: Array.from(ceSet)
          .map((id) => graph.nodes.get(id)?.name ?? id)
          .slice(0, 8),
      };
    })
    .filter((m) => m.ca > 0 || m.ce > 0)
    .sort((a, b) => b.ca + b.ce - (a.ca + a.ce));
}

// ---------------------------------------------------------------------------
// God-node detection
// ---------------------------------------------------------------------------

const TEST_PATH_RE =
  /(\.(test|spec)\.(ts|tsx|js|jsx)$|(^|[/\\])(tests?|__tests?__|spec|fixtures?|__mocks?__)[/\\])/i;

function detectGodNodes(
  graph: DependencyGraph,
  fanMetrics: ReadonlyMap<string, FanMetrics>,
  fanOutThreshold: number,
  fanInThreshold: number,
): readonly GodNodeEntry[] {
  const results: GodNodeEntry[] = [];

  for (const [nodeId, metrics] of fanMetrics) {
    if (metrics.fanOut < fanOutThreshold && metrics.fanIn < fanInThreshold) continue;

    const node = graph.nodes.get(nodeId);
    if (node === undefined || node.kind === 'module') continue;
    if (TEST_PATH_RE.test(node.filePath)) continue;

    const callerNames = graph.edges
      .filter((e) => e.to === nodeId && (e.kind === 'call' || e.kind === 'import'))
      .map((e) => graph.nodes.get(e.from)?.name ?? e.from)
      .slice(0, 10);

    const calleeNames = graph.edges
      .filter((e) => e.from === nodeId && (e.kind === 'call' || e.kind === 'import'))
      .map((e) => graph.nodes.get(e.to)?.name ?? e.to)
      .slice(0, 10);

    const severity: GodNodeEntry['severity'] =
      metrics.fanOut >= fanOutThreshold * 1.5 || metrics.fanIn >= fanInThreshold * 1.5
        ? 'high'
        : 'medium';

    const line =
      node.kind === 'function' ||
      node.kind === 'class' ||
      node.kind === 'interface' ||
      node.kind === 'typeAlias'
        ? node.line
        : undefined;

    results.push({
      nodeId,
      name: node.name,
      kind: node.kind,
      filePath: node.filePath,
      ...(line !== undefined ? { line } : {}),
      fanIn: metrics.fanIn,
      fanOut: metrics.fanOut,
      callerNames,
      calleeNames,
      severity,
    });
  }

  return results.sort((a, b) => b.fanIn + b.fanOut - (a.fanIn + a.fanOut));
}

// ---------------------------------------------------------------------------
// Dead code detection
// ---------------------------------------------------------------------------

function detectDeadCode(
  graph: DependencyGraph,
  reachable: ReadonlySet<string>,
  fanMetrics: ReadonlyMap<string, FanMetrics>,
): readonly DeadCodeEntry[] {
  const results: DeadCodeEntry[] = [];

  for (const [nodeId, node] of graph.nodes) {
    if (node.kind === 'module') continue;
    if (TEST_PATH_RE.test(node.filePath)) continue;
    if (reachable.has(nodeId)) continue;

    const fanIn = fanMetrics.get(nodeId)?.fanIn ?? 0;
    const isExported = node.kind === 'function' ? node.isExported : false;

    let reason =
      fanIn === 0
        ? 'Zero callers/importers — never referenced anywhere in the graph'
        : 'Not reachable from any entrypoint (all references come from other dead code)';

    if (!isExported && node.kind === 'function') {
      reason += '; also unexported (module-private)';
    }

    const line =
      node.kind === 'function' ||
      node.kind === 'class' ||
      node.kind === 'interface' ||
      node.kind === 'typeAlias'
        ? node.line
        : undefined;

    results.push({
      nodeId,
      kind: node.kind,
      name: node.name,
      filePath: node.filePath,
      ...(line !== undefined ? { line } : {}),
      reason,
    });
  }

  return results.sort(
    (a, b) => a.filePath.localeCompare(b.filePath) || a.name.localeCompare(b.name),
  );
}

// ---------------------------------------------------------------------------
// Duplicate / similar-signature detection
// ---------------------------------------------------------------------------

// Common names that appear in many unrelated contexts — skip them.
const COMMON_NAMES = new Set([
  'constructor',
  'toString',
  'valueOf',
  'render',
  'init',
  'setup',
  'teardown',
  'create',
  'get',
  'set',
  'update',
  'delete',
  'close',
  'open',
  'run',
  'start',
  'stop',
  'parse',
  'format',
  'validate',
  'serialize',
  'deserialize',
  'encode',
  'decode',
]);

function detectDuplicates(
  graph: DependencyGraph,
  sfCache: Map<string, ts.SourceFile>,
  minGroupSize = 2,
): readonly DuplicateGroup[] {
  const functions = Array.from(graph.nodes.values()).filter(
    (n): n is FunctionNode => n.kind === 'function',
  );

  const results: DuplicateGroup[] = [];

  // ── Group 1: identical name in multiple different files ──────────────────
  const byName = new Map<string, FunctionNode[]>();
  for (const fn of functions) {
    if (COMMON_NAMES.has(fn.name)) continue;
    const list = byName.get(fn.name) ?? [];
    list.push(fn);
    byName.set(fn.name, list);
  }

  for (const [name, fns] of byName) {
    if (fns.length < minGroupSize) continue;
    const files = new Set(fns.map((f) => f.filePath));
    if (files.size < 2) continue;

    results.push({
      signature: name,
      matchType: 'identical-name',
      nodes: fns.map((fn) => ({
        id: fn.id,
        name: fn.name,
        filePath: fn.filePath,
        line: fn.line,
      })),
      description:
        `Function \`${name}\` appears in ${files.size} different files. ` +
        `These may implement identical or near-identical logic — a shared utility or ` +
        `a base class / higher-order function could eliminate the duplication.`,
    });
  }

  // ── Group 2: identical non-trivial parameter signature in multiple files ──
  const TRIVIAL_SIGS = new Set(['string', 'number', 'boolean', 'void', 'unknown', '']);

  const bySignature = new Map<string, FunctionNode[]>();
  for (const fn of functions) {
    if (fn.parameters.length === 0) continue;
    const sig = paramSignature(fn);
    if (TRIVIAL_SIGS.has(sig)) continue;
    // Skip if signature is a single primitive
    if (/^(string|number|boolean|void|null|undefined|unknown|any)$/.test(sig)) continue;
    const list = bySignature.get(sig) ?? [];
    list.push(fn);
    bySignature.set(sig, list);
  }

  for (const [sig, fns] of bySignature) {
    if (fns.length < minGroupSize) continue;
    const files = new Set(fns.map((f) => f.filePath));
    if (files.size < 2) continue;
    // Skip if already captured by name
    const names = new Set(fns.map((f) => f.name));
    if (names.size === 1) continue;

    const shortSig = sig.length > 80 ? sig.slice(0, 77) + '…' : sig;
    results.push({
      signature: sig,
      matchType: 'identical-parameters',
      nodes: fns.map((fn) => ({
        id: fn.id,
        name: fn.name,
        filePath: fn.filePath,
        line: fn.line,
      })),
      description:
        `${fns.length} functions share the parameter signature \`(${shortSig})\` ` +
        `across ${files.size} files. This pattern often indicates a missing shared ` +
        `abstraction, an interface, or a class that should encapsulate this contract.`,
    });
  }

  // ── Group 3: structurally identical function body (AST hash) ─────────────
  // Two functions hash identically when their bodies are structurally the same
  // after normalising local/parameter names.  This catches copy-paste duplicates
  // even when the copier renamed every variable.
  const byBodyHash = new Map<string, FunctionNode[]>();

  for (const fn of functions) {
    const abs = path.isAbsolute(fn.filePath)
      ? fn.filePath
      : path.join(graph.projectRoot, fn.filePath);
    const hash = structuralHash(abs, fn.line, sfCache);
    if (hash === null) continue;

    const list = byBodyHash.get(hash) ?? [];
    list.push(fn);
    byBodyHash.set(hash, list);
  }

  // Build a set of (filePath, name) pairs already covered by groups 1 and 2
  // so we only emit body-hash groups that surface genuinely new information.
  const alreadyCovered = new Set<string>(
    results.flatMap((g) => g.nodes.map((n) => `${n.filePath}::${n.name}`)),
  );

  for (const [hash, fns] of byBodyHash) {
    if (fns.length < minGroupSize) continue;
    const files = new Set(fns.map((f) => f.filePath));
    if (files.size < 2) continue;

    // Only emit if at least two members are NOT already covered.
    const novel = fns.filter((fn) => !alreadyCovered.has(`${fn.filePath}::${fn.name}`));
    if (novel.length < 2) continue;

    results.push({
      signature: hash,
      matchType: 'identical-body',
      nodes: fns.map((fn) => ({
        id: fn.id,
        name: fn.name,
        filePath: fn.filePath,
        line: fn.line,
      })),
      description:
        `${fns.length} functions across ${files.size} files share a structurally identical ` +
        `body (AST hash \`${hash}\`). Local variable and parameter names have been ` +
        `normalised, so this detects copy-paste duplication even when variables were ` +
        `renamed. Consider extracting a shared implementation.`,
    });
  }

  return results.sort((a, b) => b.nodes.length - a.nodes.length).slice(0, 30);
}

// ---------------------------------------------------------------------------
// Hub-node detection (most heavily imported / depended-upon symbols)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AST structural hashing for body-level duplicate detection
// ---------------------------------------------------------------------------

/**
 * djb2 hash — fast, good distribution, fits in a 32-bit integer.
 * Returns an 8-character hex string.
 */
function djb2(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    // eslint-disable-next-line no-bitwise
    hash = Math.imul(hash, 33) ^ str.charCodeAt(i);
  }
  // eslint-disable-next-line no-bitwise
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Computes a structural hash of the function body starting at `startLine`.
 *
 * The hash is derived from a DFS pre-order walk of the function body's AST:
 *   - Parameter names are normalised to positional tokens `$0`, `$1`, … so
 *     functions that differ only in parameter naming hash identically.
 *   - Local variable names declared inside the body are similarly normalised.
 *   - External identifiers (imported symbols, global functions) are preserved
 *     with a `~` prefix so semantically distinct functions are not conflated.
 *   - String literals → `$S`, number literals → `$N`.
 *   - All other syntax is encoded by its `ts.SyntaxKind` number, capturing
 *     the structural shape of the code without being sensitive to formatting
 *     or comments (which Graphviz doesn't emit into the AST at all).
 *
 * Returns `null` when the source cannot be parsed, the function body cannot
 * be located at the given line, or the body is too short to be meaningful.
 */
function structuralHash(
  absFilePath: string,
  startLine: number,
  sfCache: Map<string, ts.SourceFile>,
): string | null {
  let sf = sfCache.get(absFilePath);
  if (sf === undefined) {
    try {
      const text = fs.readFileSync(absFilePath, 'utf-8');
      sf = ts.createSourceFile(
        absFilePath,
        text,
        ts.ScriptTarget.Latest,
        /* setParentNodes */ true,
      );
      sfCache.set(absFilePath, sf);
    } catch {
      return null;
    }
  }

  // Find the function-like node whose opening line matches startLine (1-based → 0-based).
  const targetLine0 = startLine - 1;
  let target: ts.FunctionLikeDeclaration | null = null;

  const findFn = (node: ts.Node): void => {
    if (target !== null) return;
    if (ts.isFunctionLike(node)) {
      const { line } = sf!.getLineAndCharacterOfPosition(node.getStart(sf));
      if (line === targetLine0) {
        target = node as ts.FunctionLikeDeclaration;
        return;
      }
    }
    ts.forEachChild(node, findFn);
  };
  findFn(sf);

  // TypeScript's control-flow analysis cannot track mutations made inside a
  // callback, so target is still typed as null here. Cast it explicitly.
  const resolvedTarget = target as ts.FunctionLikeDeclaration | null;
  if (resolvedTarget === null || resolvedTarget.body === undefined) return null;

  // ── Normalisation pass ────────────────────────────────────────────────────
  const locals = new Map<string, string>(); // original name → $N token
  let localIdx = 0;

  const registerLocal = (name: string): void => {
    if (!locals.has(name)) locals.set(name, `$${localIdx++}`);
  };

  // Register parameter names up front so they're consistently normalised even
  // when referenced before any local variable of the same name.
  for (const param of resolvedTarget.parameters) {
    if (ts.isIdentifier(param.name)) {
      registerLocal(param.name.text);
    } else if (ts.isObjectBindingPattern(param.name) || ts.isArrayBindingPattern(param.name)) {
      for (const el of param.name.elements) {
        if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) registerLocal(el.name.text);
      }
    }
  }

  const parts: string[] = [];

  const walk = (node: ts.Node): void => {
    const k = node.kind;

    // Variable declarations: register the bound name before descending so
    // subsequent references within the same scope are normalised correctly.
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      registerLocal(node.name.text);
    }

    // ── Leaf tokens ──────────────────────────────────────────────────────────
    if (k === ts.SyntaxKind.Identifier) {
      const name = (node as ts.Identifier).text;
      // Locally declared names get positional tokens; external names are
      // preserved (with a ~ prefix to distinguish from keywords).
      parts.push(locals.has(name) ? locals.get(name)! : `~${name}`);
      return; // Identifiers have no child nodes.
    }
    if (k === ts.SyntaxKind.StringLiteral || k === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
      parts.push('$S');
      return;
    }
    if (k === ts.SyntaxKind.NumericLiteral) {
      parts.push('$N');
      return;
    }
    if (k === ts.SyntaxKind.TrueKeyword) {
      parts.push('$T');
      return;
    }
    if (k === ts.SyntaxKind.FalseKeyword) {
      parts.push('$F');
      return;
    }
    if (k === ts.SyntaxKind.NullKeyword) {
      parts.push('$0');
      return;
    }

    // ── Structural node: emit kind tag and recurse ───────────────────────────
    parts.push(`[${k}]`);
    ts.forEachChild(node, walk);
  };

  walk(resolvedTarget.body);

  // Too few tokens → trivial body (single return, empty block, etc.)
  // Skip to avoid flooding results with false positives.
  if (parts.length < 8) return null;

  return djb2(parts.join(''));
}

function detectHubNodes(
  graph: DependencyGraph,
  fanMetrics: ReadonlyMap<string, FanMetrics>,
  minImporters = 4,
): readonly HubNodeEntry[] {
  const results: HubNodeEntry[] = [];

  for (const [nodeId, metrics] of fanMetrics) {
    if (metrics.fanIn < minImporters) continue;

    const node = graph.nodes.get(nodeId);
    if (node === undefined || node.kind === 'module') continue;

    const importers = graph.edges
      .filter((e) => e.to === nodeId && e.kind === 'import')
      .map((e) => graph.nodes.get(e.from)?.name ?? e.from)
      .slice(0, 10);

    if (importers.length < minImporters) continue;

    results.push({
      nodeId,
      name: node.name,
      filePath: node.filePath,
      importedByCount: metrics.fanIn,
      importedByNames: importers,
    });
  }

  return results.sort((a, b) => b.importedByCount - a.importedByCount).slice(0, 15);
}

// ---------------------------------------------------------------------------
// Source-context reader
// ---------------------------------------------------------------------------

function readSourceContext(absFilePath: string, targetLine: number, contextLines: number): string {
  try {
    const content = fs.readFileSync(absFilePath, 'utf-8');
    const lines = content.split('\n');
    const zero = targetLine - 1;
    const start = Math.max(0, zero - contextLines);
    const end = Math.min(lines.length - 1, zero + contextLines);

    return lines
      .slice(start, end + 1)
      .map((line, i) => {
        const lineNo = start + i + 1;
        const gutter = String(lineNo).padStart(4);
        const marker = lineNo === targetLine ? '▶' : ' ';
        return `${gutter} ${marker} ${line}`;
      })
      .join('\n');
  } catch {
    return '(source unavailable)';
  }
}

function absPath(projectRoot: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
}

// ---------------------------------------------------------------------------
// Main analysis entry point
// ---------------------------------------------------------------------------

export function analyzeArchitecture(
  graph: DependencyGraph,
  options: AnalysisOptions = {},
): ArchitectureReport {
  const fanOutThreshold = options.fanOutThreshold ?? 10;
  const fanInThreshold = options.fanInThreshold ?? 12;
  const minCycleLength = options.minCycleLength ?? 2;

  // SourceFile cache shared across all duplicate-detection passes so each
  // unique source file is only parsed once by the TypeScript parser.
  const sfCache = new Map<string, ts.SourceFile>();

  const reachable = computeReachable(graph);
  const fanMetrics = computeFanMetrics(graph);
  const { importCycles, callCycles } = detectCycles(graph, minCycleLength);

  const functionCount = Array.from(graph.nodes.values()).filter(
    (n) => n.kind === 'function',
  ).length;
  const classCount = Array.from(graph.nodes.values()).filter((n) => n.kind === 'class').length;
  const moduleCount = Array.from(graph.nodes.values()).filter((n) => n.kind === 'module').length;
  const typeCount = Array.from(graph.nodes.values()).filter(
    (n) => n.kind === 'typeAlias' || n.kind === 'interface',
  ).length;
  const callEdges = graph.edges.filter((e) => e.kind === 'call').length;
  const importEdges = graph.edges.filter((e) => e.kind === 'import').length;

  return {
    projectRoot: graph.projectRoot,
    generatedAt: new Date().toISOString(),
    metrics: {
      totalNodes: graph.nodes.size,
      totalEdges: graph.edges.length,
      functionCount,
      classCount,
      moduleCount,
      typeCount,
      callEdges,
      importEdges,
      entrypointCount: graph.entrypoints.length,
      reachableCount: reachable.size,
      reachabilityRatio:
        graph.nodes.size > 0 ? Math.round((reachable.size / graph.nodes.size) * 100) / 100 : 1,
    },
    deadCode: options.includeDead !== false ? detectDeadCode(graph, reachable, fanMetrics) : [],
    importCycles: options.includeCycles !== false ? importCycles : [],
    callCycles: options.includeCycles !== false ? callCycles : [],
    godNodes:
      options.includeGodNodes !== false
        ? detectGodNodes(graph, fanMetrics, fanOutThreshold, fanInThreshold)
        : [],
    duplicates: options.includeDuplicates !== false ? detectDuplicates(graph, sfCache) : [],
    moduleCoupling: options.includeCoupling !== false ? computeModuleCoupling(graph) : [],
    hubNodes: detectHubNodes(graph, fanMetrics),
  };
}

// ---------------------------------------------------------------------------
// LLM-friendly prompt generator
// ---------------------------------------------------------------------------

/**
 * Generates a structured Markdown document that an LLM can use to provide
 * actionable architecture refactoring recommendations.
 *
 * Design principles:
 * - Every finding is backed by concrete evidence (file paths, line numbers,
 *   source snippets) so the LLM doesn't need to guess.
 * - Sections are ordered by severity so the LLM prioritises the most
 *   impactful changes.
 * - The prompt ends with a structured list of specific questions to prevent
 *   generic or vague responses.
 */
export function generateArchitecturePrompt(
  report: ArchitectureReport,
  graph: DependencyGraph,
  options: PromptOptions = {},
): string {
  const contextLines = options.contextLines ?? 4;
  const maxDead = options.maxDeadCodeEntries ?? 40;
  const maxCycles = options.maxCycles ?? 12;
  const maxGodNodes = options.maxGodNodes ?? 8;
  const maxDupes = options.maxDuplicateGroups ?? 12;

  const lines: string[] = [];

  // ── Preamble ──────────────────────────────────────────────────────────────

  lines.push('# TypeScript Architecture Analysis — Refactoring Prompt');
  lines.push('');
  lines.push(
    '> **Role:** You are a senior software architect and TypeScript expert with deep knowledge',
  );
  lines.push('> of compiler design, program analysis, and software engineering principles.');
  lines.push(
    '> **Task:** Review the static analysis findings below and provide specific, actionable',
  );
  lines.push('> refactoring recommendations. For every recommendation include:');
  lines.push('> 1. **What** to change (exact files, functions, or modules)');
  lines.push('> 2. **Why** it matters (coupling, complexity, maintainability, testability)');
  lines.push('> 3. **How** — a concrete implementation approach with code sketches where helpful');
  lines.push('> 4. **Effort** estimate (hours / days)');
  lines.push('> 5. **Priority** (P0 = critical / P1 = high / P2 = medium / P3 = low)');
  lines.push('');
  lines.push(`*Analysis generated: ${report.generatedAt}*`);
  lines.push(`*Project root: \`${report.projectRoot}\`*`);
  lines.push('');

  // ── Project overview ──────────────────────────────────────────────────────

  lines.push('---');
  lines.push('');
  lines.push('## 1. Project Overview');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Total symbols | **${report.metrics.totalNodes}** |`);
  lines.push(`| Functions | ${report.metrics.functionCount} |`);
  lines.push(`| Classes | ${report.metrics.classCount} |`);
  lines.push(`| Types & Interfaces | ${report.metrics.typeCount} |`);
  lines.push(`| Modules (files) | ${report.metrics.moduleCount} |`);
  lines.push(`| Call edges | ${report.metrics.callEdges} |`);
  lines.push(`| Import edges | ${report.metrics.importEdges} |`);
  lines.push(`| Total edges | ${report.metrics.totalEdges} |`);
  lines.push(`| Entrypoints | ${report.metrics.entrypointCount} |`);
  lines.push(
    `| Reachable from entrypoints | **${report.metrics.reachableCount} / ${report.metrics.totalNodes}** ` +
      `(${Math.round(report.metrics.reachabilityRatio * 100)}%) |`,
  );

  lines.push('');

  const deadRatio = report.deadCode.length / Math.max(report.metrics.totalNodes, 1);
  if (deadRatio > 0.1) {
    lines.push(
      `> ⚠️ **${Math.round(deadRatio * 100)}% of the codebase is unreachable from entrypoints.** ` +
        `This is a significant dead-code burden.`,
    );
    lines.push('');
  }

  // ── Entrypoints ───────────────────────────────────────────────────────────

  if (graph.entrypoints.length > 0) {
    lines.push('**Entrypoints:**');
    lines.push('');
    for (const ep of graph.entrypoints) {
      const rel = path.isAbsolute(ep) ? path.relative(report.projectRoot, ep) : ep;
      lines.push(`- \`${rel}\``);
    }
    lines.push('');
  }

  // ── Critical Issues ───────────────────────────────────────────────────────

  lines.push('---');
  lines.push('');
  lines.push('## 2. Critical Issues');
  lines.push('');

  // 2a — Import cycles
  const visibleImportCycles = report.importCycles.slice(0, maxCycles);
  if (visibleImportCycles.length > 0) {
    lines.push('### 2a. Circular Import Dependencies');
    lines.push('');
    lines.push(
      'Circular imports cause **module initialisation order problems** in Node.js ' +
        '(values are `undefined` at import time), break tree-shaking, and tightly couple ' +
        'unrelated concerns. Each cycle below should be broken.',
    );
    lines.push('');

    for (let i = 0; i < visibleImportCycles.length; i++) {
      const cycle = visibleImportCycles[i];
      if (cycle === undefined) continue;
      lines.push(
        `**Cycle ${i + 1}** — ${cycle.length} nodes${cycle.length > cycle.nodeIds.length ? ' (showing first 10)' : ''}`,
      );
      lines.push('');
      lines.push('```');
      lines.push(
        cycle.nodeNames.join(' → ') +
          (cycle.length > cycle.nodeIds.length ? ' → …' : ' → ' + (cycle.nodeNames[0] ?? '')),
      );
      lines.push('```');
      lines.push('');
      lines.push('Files involved:');
      for (const fp of cycle.filePaths) {
        lines.push(`- \`${fp}\``);
      }
      lines.push('');
    }

    if (report.importCycles.length > maxCycles) {
      lines.push(
        `> *${report.importCycles.length - maxCycles} additional import cycles truncated.*`,
      );
      lines.push('');
    }

    lines.push('**Common resolution strategies:**');
    lines.push('');
    lines.push(
      '1. **Extract shared types** — Create a `types.ts` or `contracts.ts` module that both ' +
        'sides import from but neither owns.',
    );
    lines.push(
      '2. **Dependency inversion** — Define an interface in the module that is currently the ' +
        '"sink" and have the "source" depend on the interface rather than the implementation.',
    );
    lines.push(
      '3. **Mediator / event bus** — Replace direct imports with events or callbacks so neither ' +
        'module holds a compile-time reference to the other.',
    );
    lines.push('');
  } else {
    lines.push('### 2a. Circular Import Dependencies');
    lines.push('');
    lines.push('✅ No circular import dependencies detected.');
    lines.push('');
  }

  // 2b — Mutual recursion / call cycles
  const visibleCallCycles = report.callCycles.slice(0, Math.min(maxCycles, 6));
  if (visibleCallCycles.length > 0) {
    lines.push('### 2b. Mutual Recursion Cycles');
    lines.push('');
    lines.push(
      'These functions call each other in a cycle (mutual recursion). While sometimes ' +
        'intentional, deep cycles indicate tangled logic that is hard to test in isolation.',
    );
    lines.push('');

    for (let i = 0; i < visibleCallCycles.length; i++) {
      const cycle = visibleCallCycles[i];
      if (cycle === undefined) continue;
      lines.push(`**Cycle ${i + 1}:** \`${cycle.nodeNames.join(' ↔ ')}\``);
      lines.push('');
      lines.push('Files:');
      for (const fp of cycle.filePaths) {
        lines.push(`- \`${fp}\``);
      }
      lines.push('');
    }
  }

  // ── God-node analysis ─────────────────────────────────────────────────────

  lines.push('---');
  lines.push('');
  lines.push('## 3. High-Complexity Nodes (God Functions / Hub Types)');
  lines.push('');
  lines.push(
    'Nodes with unusually high fan-out (too many dependencies) or fan-in (too many ' +
      'dependents) are architectural bottlenecks. They violate the **Single Responsibility ' +
      'Principle** and create a "God Object" anti-pattern. Changes here ripple across the ' +
      'entire codebase.',
  );
  lines.push('');
  lines.push(
    '> **Interpretation:** Fan-out ≥ 10 → "does too much". Fan-in ≥ 12 → ' +
      '"too many things depend on it" (high change-impact radius).',
  );
  lines.push('');

  const visibleGodNodes = report.godNodes.slice(0, maxGodNodes);
  if (visibleGodNodes.length === 0) {
    lines.push('✅ No god nodes detected at current thresholds.');
    lines.push('');
  } else {
    for (const gn of visibleGodNodes) {
      const sev = gn.severity === 'high' ? '🔴' : '🟡';
      lines.push(
        `#### ${sev} \`${gn.name}\` — ${gn.filePath}${gn.line !== undefined ? `:${gn.line}` : ''}`,
      );
      lines.push('');
      lines.push(`- **Kind:** ${gn.kind}`);
      lines.push(`- **Fan-in (callers/importers):** ${gn.fanIn}`);
      lines.push(`- **Fan-out (callees/imports):** ${gn.fanOut}`);
      if (gn.callerNames.length > 0) {
        lines.push(`- **Called by:** ${gn.callerNames.map((n) => `\`${n}\``).join(', ')}`);
      }
      if (gn.calleeNames.length > 0) {
        lines.push(`- **Calls:** ${gn.calleeNames.map((n) => `\`${n}\``).join(', ')}`);
      }
      lines.push('');

      // Source context
      if (gn.line !== undefined) {
        const abs = absPath(report.projectRoot, gn.filePath);
        const ctx = readSourceContext(abs, gn.line, contextLines);
        lines.push('```typescript');
        lines.push(`// ${gn.filePath}:${gn.line}`);
        lines.push(ctx);
        lines.push('```');
        lines.push('');
      }
    }

    if (report.godNodes.length > maxGodNodes) {
      lines.push(
        `> *${report.godNodes.length - maxGodNodes} additional god-node entries truncated.*`,
      );
      lines.push('');
    }
  }

  // ── Dead code ─────────────────────────────────────────────────────────────

  lines.push('---');
  lines.push('');
  lines.push('## 4. Dead Code Candidates');
  lines.push('');

  if (report.deadCode.length === 0) {
    lines.push('✅ All non-test symbols are reachable from at least one entrypoint.');
    lines.push('');
  } else {
    lines.push(
      `**${report.deadCode.length} symbol(s)** are not reachable from any entrypoint via ` +
        `call or import chains. Test files and fixtures are excluded from this list.`,
    );
    lines.push('');
    lines.push(
      '> **Caution:** Exported symbols in library packages may be intentional public API even ' +
        'if unused internally. Verify before removing.',
    );
    lines.push('');

    // Group by file for readability
    const byFile = new Map<string, DeadCodeEntry[]>();
    for (const entry of report.deadCode.slice(0, maxDead)) {
      const list = byFile.get(entry.filePath) ?? [];
      list.push(entry);
      byFile.set(entry.filePath, list);
    }

    for (const [filePath, entries] of byFile) {
      lines.push(`**\`${filePath}\`**`);
      lines.push('');
      lines.push('| Symbol | Kind | Line | Reason |');
      lines.push('|--------|------|------|--------|');
      for (const e of entries) {
        const lineStr = e.line !== undefined ? String(e.line) : '—';
        const shortReason = e.reason.length > 60 ? e.reason.slice(0, 57) + '…' : e.reason;
        lines.push(`| \`${e.name}\` | ${e.kind} | ${lineStr} | ${shortReason} |`);
      }
      lines.push('');
    }

    if (report.deadCode.length > maxDead) {
      lines.push(`> *Showing first ${maxDead} of ${report.deadCode.length} dead-code entries.*`);
      lines.push('');
    }
  }

  // ── Module coupling ───────────────────────────────────────────────────────

  lines.push('---');
  lines.push('');
  lines.push("## 5. Module Coupling Analysis (Martin's Stability Metrics)");
  lines.push('');
  lines.push(
    'Instability **I = Ce / (Ca + Ce)** where Ca = afferent coupling (modules that depend ' +
      'on this one) and Ce = efferent coupling (modules this one depends on).',
  );
  lines.push('');
  lines.push(
    '- **I ≈ 0** (stable): Many things depend on it; it depends on few. Should be abstract ' +
      '(interfaces/types) to allow extension without modification.',
  );
  lines.push(
    '- **I ≈ 1** (unstable): Few things depend on it; it depends on many. Acceptable for ' +
      'top-level orchestrators (entrypoints, CLI) but problematic for shared utilities.',
  );
  lines.push('');

  if (report.moduleCoupling.length === 0) {
    lines.push('No module coupling data available (no import edges detected).');
    lines.push('');
  } else {
    lines.push('| Module | Ca | Ce | I | Verdict |');
    lines.push('|--------|----|----|---|---------|');
    for (const m of report.moduleCoupling.slice(0, 20)) {
      const verdictIcon =
        m.verdict === 'stable-abstract'
          ? '✅ stable-abstract'
          : m.verdict === 'stable-concrete'
            ? '⚠️ stable-concrete'
            : m.verdict === 'unstable'
              ? '🔴 unstable'
              : m.verdict === 'balanced'
                ? '🟢 balanced'
                : '⬜ isolated';
      lines.push(
        `| \`${m.filePath}\` | ${m.ca} | ${m.ce} | ${m.instability.toFixed(2)} | ${verdictIcon} |`,
      );
    }
    lines.push('');

    // Flag problematic patterns
    const stableConcrete = report.moduleCoupling.filter(
      (m) => m.verdict === 'stable-concrete' && m.ca >= 3,
    );
    if (stableConcrete.length > 0) {
      lines.push('**⚠️ Stable-but-Concrete Modules (Violate Stable Abstractions Principle):**');
      lines.push('');
      lines.push(
        'These modules are heavily depended upon (stable) but contain concrete implementations ' +
          'rather than abstractions. Any change forces all dependents to update.',
      );
      lines.push('');
      for (const m of stableConcrete.slice(0, 5)) {
        lines.push(
          `- \`${m.filePath}\` — Ca=${m.ca}, Ce=${m.ce}. ` +
            `Dependents: ${m.dependents.map((d) => `\`${d}\``).join(', ')}`,
        );
      }
      lines.push('');
    }
  }

  // ── Hub nodes ─────────────────────────────────────────────────────────────

  if (report.hubNodes.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## 6. Hub Nodes (Most Widely Imported Symbols)');
    lines.push('');
    lines.push(
      'These symbols are imported by many other modules. A breaking change here has the ' +
        'maximum blast radius. They are strong candidates for interface extraction.',
    );
    lines.push('');
    lines.push('| Symbol | File | Imported by (count) | Importers (sample) |');
    lines.push('|--------|------|--------------------|--------------------|');
    for (const hub of report.hubNodes) {
      lines.push(
        `| \`${hub.name}\` | \`${hub.filePath}\` | ${hub.importedByCount} | ` +
          `${hub.importedByNames
            .slice(0, 4)
            .map((n) => `\`${n}\``)
            .join(', ')} |`,
      );
    }
    lines.push('');
  }

  // ── Duplicate signatures ──────────────────────────────────────────────────

  const visibleDupes = report.duplicates.slice(0, maxDupes);
  if (visibleDupes.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## 7. Potential Code Duplication');
    lines.push('');
    lines.push(
      'The following groups of functions were identified as duplicates by three independent ' +
        'passes: (1) **identical name** across files, (2) **identical parameter-type signature** ' +
        'across files, and (3) **identical AST body hash** — local/parameter names are normalised ' +
        'before hashing, so copy-paste duplication is detected even when variables were renamed.',
    );
    lines.push('');

    for (let i = 0; i < visibleDupes.length; i++) {
      const group = visibleDupes[i];
      if (group === undefined) continue;
      const tag =
        group.matchType === 'identical-name'
          ? 'Same name'
          : group.matchType === 'identical-parameters'
            ? 'Same parameters'
            : 'Identical body (AST hash)';
      lines.push(`### Duplicate Group ${i + 1} — ${tag}`);
      lines.push('');
      lines.push(group.description);
      lines.push('');
      lines.push('| Function | File | Line |');
      lines.push('|----------|------|------|');
      for (const n of group.nodes) {
        lines.push(`| \`${n.name}\` | \`${n.filePath}\` | ${n.line ?? '—'} |`);
      }
      lines.push('');
    }

    if (report.duplicates.length > maxDupes) {
      lines.push(
        `> *${report.duplicates.length - maxDupes} additional duplicate groups truncated.*`,
      );
      lines.push('');
    }
  }

  // ── Top refactor candidates with source context ───────────────────────────

  lines.push('---');
  lines.push('');
  lines.push('## 8. Primary Refactor Targets — Source Context');
  lines.push('');
  lines.push(
    'Source snippets for the top candidates to give you enough context to propose concrete changes.',
  );
  lines.push('');

  // Top 3 god nodes with source
  const godNodesWithLine = report.godNodes.filter((g) => g.line !== undefined).slice(0, 3);
  for (const gn of godNodesWithLine) {
    if (gn.line === undefined) continue;
    lines.push(`### \`${gn.name}\` (${gn.filePath}:${gn.line})`);
    lines.push('');
    lines.push(`Fan-in: **${gn.fanIn}** | Fan-out: **${gn.fanOut}** | Kind: ${gn.kind}`);
    lines.push('');
    const abs = absPath(report.projectRoot, gn.filePath);
    const ctx = readSourceContext(abs, gn.line, contextLines + 2);
    lines.push('```typescript');
    lines.push(ctx);
    lines.push('```');
    lines.push('');
  }

  // Top import cycle with source snippets for each file
  const topImportCycle = report.importCycles[0];
  if (topImportCycle !== undefined && topImportCycle.filePaths.length > 1) {
    lines.push(`### Import Cycle: ${topImportCycle.nodeNames.slice(0, 4).join(' → ')}…`);
    lines.push('');
    lines.push('Module declarations at the head of each file in the cycle:');
    lines.push('');
    for (const fp of topImportCycle.filePaths.slice(0, 4)) {
      const abs = absPath(report.projectRoot, fp);
      const ctx = readSourceContext(abs, 1, 0);
      if (ctx !== '(source unavailable)') {
        lines.push(`**\`${fp}\`** — first lines:`);
        lines.push('```typescript');
        lines.push(ctx);
        lines.push('```');
        lines.push('');
      }
    }
  }

  // ── Recommendations summary ───────────────────────────────────────────────

  lines.push('---');
  lines.push('');
  lines.push('## 9. Specific Questions — Please Answer Each');
  lines.push('');
  lines.push('Based on the evidence above, provide concrete answers to each of the following:');
  lines.push('');

  let qIdx = 1;

  if (report.importCycles.length > 0) {
    lines.push(
      `**Q${qIdx++}. Circular imports.** For each import cycle above, propose the cleanest ` +
        `architectural solution. Identify whether the cycle arises from a missing ` +
        `abstraction layer, a domain boundary violation, or a design inversion error. ` +
        `Give a concrete refactoring plan for the top 3 cycles.`,
    );
    lines.push('');
  }

  if (report.godNodes.length > 0) {
    const topGod = report.godNodes[0];
    if (topGod !== undefined) {
      lines.push(
        `**Q${qIdx++}. God node decomposition.** The function \`${topGod.name}\` in ` +
          `\`${topGod.filePath}\` has fan-out ${topGod.fanOut} and fan-in ${topGod.fanIn}. ` +
          `Provide a concrete decomposition: name the sub-functions that should be ` +
          `extracted, describe each one's responsibility, and show the new call graph shape.`,
      );
      lines.push('');
    }
  }

  if (report.deadCode.length > 0) {
    lines.push(
      `**Q${qIdx++}. Dead code removal.** ${report.deadCode.length} symbols are unreachable ` +
        `from entrypoints. Review the dead code table (Section 4) and categorise each file's ` +
        `dead symbols as: (a) safe to delete, (b) potentially intentional public API, or ` +
        `(c) test/utility code that should be moved to a dedicated test-helper module.`,
    );
    lines.push('');
  }

  if (report.moduleCoupling.some((m) => m.verdict === 'stable-concrete' && m.ca >= 3)) {
    lines.push(
      `**Q${qIdx++}. Stable-abstractions principle.** Several stable modules contain concrete ` +
        `implementations rather than interfaces. For each "stable-concrete" module in Section 5 ` +
        `with Ca ≥ 3, propose how to introduce an abstraction layer (interface or abstract class) ` +
        `so dependents can be decoupled from the implementation details.`,
    );
    lines.push('');
  }

  if (report.duplicates.length > 0) {
    const nameCount = report.duplicates.filter((d) => d.matchType === 'identical-name').length;
    const bodyCount = report.duplicates.filter((d) => d.matchType === 'identical-body').length;
    lines.push(
      `**Q${qIdx++}. Duplicate consolidation.** Section 7 lists ${report.duplicates.length} ` +
        `duplicate groups (${nameCount} by identical name, ${bodyCount} by identical AST body hash). ` +
        `For each group determine: (a) should the implementations be merged into a shared utility, ` +
        `(b) do they represent intentional polymorphism that should be modelled as an interface or ` +
        `strategy pattern, or (c) are they coincidental with genuinely different semantics? ` +
        `For the body-hash groups, explain why structurally identical code exists in separate locations.`,
    );
    lines.push('');
  }

  if (report.hubNodes.length > 0) {
    const topHub = report.hubNodes[0];
    if (topHub !== undefined) {
      lines.push(
        `**Q${qIdx++}. Hub node risk mitigation.** \`${topHub.name}\` is imported by ` +
          `${topHub.importedByCount} modules. Should it be split, wrapped behind an interface, ` +
          `or left as-is? If it should be split, propose the new boundary and name each piece.`,
      );
      lines.push('');
    }
  }

  lines.push(
    `**Q${qIdx++}. Overall architecture assessment.** Based on the coupling metrics, cycle ` +
      `structure, and dead-code ratio, describe the current architectural style (layered, ` +
      `hexagonal, modular monolith, etc.) and whether it is being applied consistently. ` +
      `Identify the top 3 structural violations and the refactoring sequence that would ` +
      `address them with minimum disruption.`,
  );
  lines.push('');

  lines.push(
    `**Q${qIdx}. Prioritised refactoring roadmap.** Synthesise your answers into a numbered ` +
      `list of refactoring tasks ordered by impact × effort ratio. For each task include: ` +
      `priority (P0–P3), estimated hours, and the key risk or dependency to resolve first.`,
  );
  lines.push('');

  // ── Footer ────────────────────────────────────────────────────────────────

  lines.push('---');
  lines.push('');
  lines.push(
    '*This prompt was generated by `ts-investigator architect`. ' +
      'Re-run after refactoring to measure improvement.*',
  );
  lines.push('');

  return lines.join('\n');
}
