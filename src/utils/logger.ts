import pino, { type Logger, type LoggerOptions } from 'pino';

export type LogLevel = 'silent' | 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface LoggerConfig {
  readonly level: LogLevel;
  readonly pretty: boolean;
  readonly name?: string;
}

const DEFAULT_CONFIG: LoggerConfig = {
  level: 'info',
  pretty: process.stdout.isTTY === true,
};

/**
 * Creates a configured Pino logger instance.
 * Use this factory rather than importing pino directly so that all loggers
 * in the codebase share the same shape and can be swapped in tests.
 */
export function createLogger(config: Partial<LoggerConfig> = {}): Logger {
  const resolved: LoggerConfig = { ...DEFAULT_CONFIG, ...config };

  const options: LoggerOptions = {
    ...(resolved.name !== undefined ? { name: resolved.name } : {}),
    level: resolved.level,
    ...(resolved.name !== undefined ? { base: { name: resolved.name } } : {}),
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  };

  if (resolved.pretty) {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname,name',
          messageFormat: resolved.name !== undefined ? `[{name}] {msg}` : '{msg}',
        },
      },
    });
  }

  return pino(options);
}

/**
 * Sets the log level on an existing logger instance.
 * Used by CLI handlers to apply the --verbose flag after construction.
 */
export function setLogLevel(logger: Logger, level: LogLevel): void {
  logger.level = level;
}

/**
 * Creates a child logger scoped to a specific module or subsystem.
 * Prefer this over creating top-level loggers in library code.
 *
 * @example
 * const log = createChildLogger(rootLogger, 'analyzer');
 * log.info({ filePath }, 'Scanning file');
 */
export function createChildLogger(parent: Logger, name: string): Logger {
  return parent.child({ name });
}

/**
 * A no-op logger for use in tests or when logging is explicitly disabled.
 */
export function createSilentLogger(): Logger {
  return createLogger({ level: 'silent', pretty: false });
}
