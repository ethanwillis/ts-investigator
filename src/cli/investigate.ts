import type { Logger } from 'pino';
import { createLogger, pathExists } from '../utils/index.js';
import { startServer } from '../server/index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InvestigateOptions {
  readonly graph: string;
  readonly port: number;
  readonly open: boolean;
  readonly verbose: boolean;
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

/**
 * Runs the `investigate` command end-to-end:
 *   check graph file → start server → register shutdown handlers
 *
 * All errors are reported via the structured logger and terminate the process
 * with exit code 1. The process stays alive (serving HTTP) until a SIGINT or
 * SIGTERM signal is received, at which point it shuts down cleanly.
 */
export async function runInvestigate(options: InvestigateOptions): Promise<void> {
  // 1. Create the root logger for this command.
  const logger: Logger = createLogger({
    level: options.verbose ? 'debug' : 'info',
    pretty: true,
    name: 'investigate',
  });

  // 2. Verify the graph file exists before attempting to start the server.
  if (!pathExists(options.graph)) {
    logger.error(
      { graphPath: options.graph },
      `Graph file not found: "${options.graph}". Run \`ts-investigator analyze\` first.`,
    );
    process.exit(1);
  }

  logger.debug({ graphPath: options.graph, port: options.port }, 'Starting investigation server');

  // 3. Start the Express server.
  const serverResult = await startServer({
    port: options.port,
    graphPath: options.graph,
    autoOpen: options.open,
    logger,
  });

  // 4. Bail on server start errors.
  if (serverResult.isErr()) {
    logger.error(
      { code: serverResult.error.code, cause: serverResult.error.cause },
      serverResult.error.message,
    );
    process.exit(1);
  }

  const server = serverResult.value;

  // 5. Log the URL and usage instructions.
  logger.info({ url: server.url }, `ts-investigator is running at ${server.url}`);
  logger.info('Press Ctrl+C to stop');

  // 6. Register graceful shutdown handlers for SIGINT and SIGTERM.
  const shutdown = (): void => {
    logger.info('Shutting down server…');
    server
      .close()
      .then(() => {
        logger.info('Server stopped');
        process.exit(0);
      })
      .catch((closeErr: unknown) => {
        logger.error({ cause: closeErr }, 'Error while closing server');
        process.exit(0);
      });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
