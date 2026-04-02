import type { Logger } from 'pino';
import { createLogger } from '../utils/index.js';
import { ProjectScanner } from '../analyzer/index.js';
import { buildGraph } from '../analyzer/index.js';
import { writeGraph } from '../graph/serializer.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AnalyzeOptions {
  readonly entrypoint?: string;
  readonly output: string;
  readonly project: string;
  readonly verbose: boolean;
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

/**
 * Runs the `analyze` command end-to-end:
 *   scan → build graph → serialize to disk
 *
 * All errors are reported via the structured logger and terminate the process
 * with exit code 1. On success the process returns normally (exit code 0).
 */
export function runAnalyze(options: AnalyzeOptions): Promise<void> {
  // 1. Create the root logger for this command.
  const logger: Logger = createLogger({
    level: options.verbose ? 'debug' : 'info',
    pretty: true,
    name: 'analyze',
  });

  // 2. Log that analysis is starting.
  logger.info(
    { projectRoot: process.cwd(), output: options.output },
    'Starting TypeScript project analysis',
  );

  // 3. Scan the project.
  const scanner = new ProjectScanner();
  const scanResult = scanner.scan({
    projectRoot: process.cwd(),
    ...(options.project !== './tsconfig.json' ? { tsConfigPath: options.project } : {}),
    ...(options.entrypoint !== undefined ? { entrypoints: [options.entrypoint] } : {}),
  });

  // 4. Bail on scan errors.
  if (scanResult.isErr()) {
    logger.error(
      { code: scanResult.error.code, cause: scanResult.error.cause },
      scanResult.error.message,
    );
    process.exit(1);
  }

  logger.debug(
    {
      tsConfigPath: scanResult.value.tsConfigPath,
      sourceFileCount: scanResult.value.sourceFiles.length,
      entrypointCount: scanResult.value.entrypoints.length,
    },
    'Project scan complete',
  );

  // 5. Build the dependency graph.
  const graphResult = buildGraph(scanResult.value, {}, logger);

  // 6. Bail on graph build errors.
  if (graphResult.isErr()) {
    logger.error(
      { code: graphResult.error.code, cause: graphResult.error.cause },
      graphResult.error.message,
    );
    process.exit(1);
  }

  const graph = graphResult.value;

  // 7. Write the graph JSON to disk.
  const writeResult = writeGraph(options.output, graph);

  // 8. Bail on write errors.
  if (writeResult.isErr()) {
    logger.error(
      { code: writeResult.error.code, cause: writeResult.error.cause },
      writeResult.error.message,
    );
    process.exit(1);
  }

  // 9. Report success.
  logger.info(
    {
      nodes: graph.nodes.size,
      edges: graph.edges.length,
      output: options.output,
    },
    `Analysis complete: ${graph.nodes.size} nodes, ${graph.edges.length} edges → ${options.output}`,
  );

  return Promise.resolve();
}
