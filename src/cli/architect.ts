import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/index.js';
import { readGraph } from '../graph/serializer.js';
import {
  analyzeArchitecture,
  generateArchitecturePrompt,
} from '../analyzer/architectureAnalyzer.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ArchitectOptions {
  readonly graph: string;
  readonly output?: string;
  readonly contextLines: number;
  readonly verbose: boolean;
  readonly noDead: boolean;
  readonly noCycles: boolean;
  readonly noDuplicates: boolean;
  readonly noCoupling: boolean;
  readonly fanOut: number;
  readonly fanIn: number;
  /**
   * Minimum cycle length to report.
   * Set to 3 to suppress 2-node mutual recursion (often intentional).
   * @default 2
   */
  readonly minCycleLength: number;
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

/**
 * Runs the `architect` command:
 *   read graph → run architecture analyses → emit LLM-friendly prompt
 *
 * The prompt is written to stdout by default, or to --output <file> if
 * provided. All diagnostic logging goes to stderr via the Pino logger so
 * stdout output remains clean and pipeable.
 *
 * All errors are reported via the structured logger and terminate the process
 * with exit code 1.
 */
export async function runArchitect(options: ArchitectOptions): Promise<void> {
  const log = createLogger({
    level: options.verbose ? 'debug' : 'info',
    pretty: true,
    name: 'architect',
  });

  // ── 1. Resolve the graph file path ──────────────────────────────────────
  const graphPath = path.resolve(options.graph);

  if (!fs.existsSync(graphPath)) {
    log.error(
      { graphPath },
      [
        `Graph file not found: ${graphPath}`,
        '',
        'Run the analyze command first to generate it:',
        '  ts-investigator analyze',
        '',
        'Or specify a different path with --graph <path>.',
      ].join('\n'),
    );
    process.exit(1);
  }

  // ── 2. Load the graph ────────────────────────────────────────────────────
  log.info({ graphPath }, 'Reading dependency graph');

  const graphResult = readGraph(graphPath);

  if (graphResult.isErr()) {
    log.error(
      { code: graphResult.error.code, cause: graphResult.error.message },
      `Failed to read graph file: ${graphResult.error.message}`,
    );
    process.exit(1);
  }

  const graph = graphResult.value;

  log.info(
    {
      nodeCount: graph.nodes.size,
      edgeCount: graph.edges.length,
      entrypoints: graph.entrypoints.length,
    },
    'Graph loaded',
  );

  // ── 3. Run architecture analyses ─────────────────────────────────────────
  log.info('Running architecture analysis (reachability, cycles, coupling, duplication…)');

  const report = analyzeArchitecture(graph, {
    includeDead: !options.noDead,
    includeCycles: !options.noCycles,
    includeDuplicates: !options.noDuplicates,
    includeCoupling: !options.noCoupling,
    fanOutThreshold: options.fanOut,
    fanInThreshold: options.fanIn,
    minCycleLength: options.minCycleLength,
  });

  log.info(
    {
      deadCode: report.deadCode.length,
      importCycles: report.importCycles.length,
      callCycles: report.callCycles.length,
      godNodes: report.godNodes.length,
      duplicateGroups: report.duplicates.length,
      moduleCoupling: report.moduleCoupling.length,
      hubNodes: report.hubNodes.length,
      reachabilityPct: `${Math.round(report.metrics.reachabilityRatio * 100)}%`,
    },
    'Analysis complete',
  );

  // Surface notable findings at warn level so they appear even without --verbose
  if (report.importCycles.length > 0) {
    log.warn(
      { count: report.importCycles.length },
      `Found ${report.importCycles.length} circular import dependency cycle(s)`,
    );
  }

  if (report.deadCode.length > 0) {
    const pct = Math.round((report.deadCode.length / graph.nodes.size) * 100);
    log.warn(
      { count: report.deadCode.length, pct: `${pct}%` },
      `${report.deadCode.length} dead-code candidates (${pct}% of codebase)`,
    );
  }

  if (report.godNodes.filter((g) => g.severity === 'high').length > 0) {
    log.warn(
      { count: report.godNodes.filter((g) => g.severity === 'high').length },
      'High-severity god nodes detected (consider decomposition)',
    );
  }

  // ── 4. Generate the LLM prompt ───────────────────────────────────────────
  log.info('Generating LLM architecture prompt');

  const prompt = generateArchitecturePrompt(report, graph, {
    contextLines: options.contextLines,
  });

  // ── 5. Output ─────────────────────────────────────────────────────────────
  if (options.output !== undefined) {
    const outputPath = path.resolve(options.output);

    // Ensure parent directory exists
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, prompt, 'utf-8');

    log.info(
      { output: outputPath, bytes: Buffer.byteLength(prompt, 'utf-8') },
      `Prompt written to ${outputPath}`,
    );

    log.info(
      [
        '',
        'Next steps:',
        `  1. Open ${outputPath} in your editor`,
        '  2. Paste the contents into Claude, GPT-4, or any LLM chat',
        '  3. Review the recommendations and apply the highest-priority refactors',
        '  4. Re-run `ts-investigator analyze && ts-investigator architect` to measure improvement',
      ].join('\n'),
    );
  } else {
    // Write prompt to stdout — logging already goes to stderr via pino-pretty
    process.stdout.write(prompt);
    process.stdout.write('\n');
  }

  return Promise.resolve();
}
