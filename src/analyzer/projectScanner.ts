import * as path from 'path';
import ts from 'typescript';
import { ok, err, type Result } from 'neverthrow';
import { findFileUpward, walkDirectory, isFile, resolvePath } from '../utils/index.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface ScanOptions {
  readonly projectRoot: string;
  readonly tsConfigPath?: string;
  readonly entrypoints?: readonly string[];
}

export interface ScanResult {
  readonly projectRoot: string;
  readonly tsConfigPath: string;
  readonly sourceFiles: readonly string[];
  readonly entrypoints: readonly string[];
  readonly program: ts.Program;
}

export interface ScannerError {
  readonly kind: 'ScannerError';
  readonly code: 'TSCONFIG_NOT_FOUND' | 'INVALID_TSCONFIG' | 'NO_SOURCE_FILES' | 'UNKNOWN';
  readonly message: string;
  readonly cause?: unknown;
}

export interface IProjectScanner {
  scan(options: ScanOptions): Result<ScanResult, ScannerError>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git']);

function makeScannerError(
  code: ScannerError['code'],
  message: string,
  cause?: unknown,
): ScannerError {
  return { kind: 'ScannerError', code, message, cause };
}

/**
 * Resolves the tsconfig.json path. Uses `tsConfigPath` if provided,
 * otherwise searches upward from `projectRoot`.
 */
function resolveTsConfigPath(
  projectRoot: string,
  tsConfigPath?: string,
): Result<string, ScannerError> {
  if (tsConfigPath !== undefined) {
    const resolved = resolvePath(tsConfigPath);
    if (!isFile(resolved)) {
      return err(
        makeScannerError(
          'TSCONFIG_NOT_FOUND',
          `Explicit tsconfig path does not exist or is not a file: ${resolved}`,
        ),
      );
    }
    return ok(resolved);
  }

  const found = findFileUpward(projectRoot, 'tsconfig.json');
  if (found === null) {
    return err(
      makeScannerError(
        'TSCONFIG_NOT_FOUND',
        `Could not find tsconfig.json walking upward from: ${projectRoot}`,
      ),
    );
  }
  return ok(found);
}

/**
 * Parses a tsconfig.json using the TypeScript compiler API.
 * Returns the parsed command line or a ScannerError.
 */
function parseTsConfig(
  tsConfigPath: string,
  _projectRoot: string,
): Result<ts.ParsedCommandLine, ScannerError> {
  const readResult = ts.readConfigFile(tsConfigPath, (p) => ts.sys.readFile(p));

  if (readResult.error !== undefined) {
    const msg = ts.flattenDiagnosticMessageText(readResult.error.messageText, '\n');
    return err(
      makeScannerError(
        'INVALID_TSCONFIG',
        `Failed to read tsconfig at ${tsConfigPath}: ${msg}`,
        readResult.error,
      ),
    );
  }

  const parsed = ts.parseJsonConfigFileContent(
    readResult.config as Record<string, unknown>,
    ts.sys,
    path.dirname(tsConfigPath),
    undefined,
    tsConfigPath,
  );

  if (parsed.errors.length > 0) {
    const messages = parsed.errors
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      .join('; ');
    return err(
      makeScannerError(
        'INVALID_TSCONFIG',
        `tsconfig parse errors in ${tsConfigPath}: ${messages}`,
        parsed.errors,
      ),
    );
  }

  return ok(parsed);
}

/**
 * Filters a list of file paths to only include .ts/.tsx files that are
 * inside the project root and not inside an excluded directory.
 */
function filterSourceFiles(files: readonly string[], projectRoot: string): string[] {
  const resolvedRoot = resolvePath(projectRoot);

  return files.filter((f) => {
    const ext = path.extname(f);
    if (ext !== '.ts' && ext !== '.tsx') return false;

    // Must be inside project root
    const rel = path.relative(resolvedRoot, f);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false;

    // Must not be inside an excluded directory
    const parts = rel.split(path.sep);
    if (parts.some((part) => EXCLUDED_DIRS.has(part))) return false;

    // Skip .d.ts declaration files
    if (f.endsWith('.d.ts')) return false;

    return true;
  });
}

/**
 * Resolves entrypoints for a scan. Priority:
 * 1. Explicit entrypoints from ScanOptions (resolved to absolute paths).
 * 2. Files from tsconfig `fileNames` that look like primary entries.
 * 3. Any file named `index.ts` or `index.tsx` directly in projectRoot.
 * 4. All source files as a fallback.
 */
function resolveEntrypoints(
  explicitEntrypoints: readonly string[] | undefined,
  tsConfigFileNames: readonly string[],
  sourceFiles: readonly string[],
  projectRoot: string,
): string[] {
  // 1. Explicit entrypoints
  if (explicitEntrypoints !== undefined && explicitEntrypoints.length > 0) {
    return explicitEntrypoints.map((ep) => resolvePath(ep));
  }

  // 2. Use tsconfig fileNames if they point to meaningful entry files
  //    (filter to only those that are in our source file list)
  const sourceSet = new Set(sourceFiles);
  const tsConfigEntries = tsConfigFileNames.filter((f) => sourceSet.has(f));
  if (tsConfigEntries.length > 0) {
    // Prefer files named index.ts / index.tsx within the tsconfig list first
    const indexEntries = tsConfigEntries.filter((f) => {
      const base = path.basename(f);
      return base === 'index.ts' || base === 'index.tsx';
    });
    if (indexEntries.length > 0) return indexEntries;
    // Return all tsconfig-listed entries as a reasonable default
    return tsConfigEntries;
  }

  // 3. Any index.ts / index.tsx directly in projectRoot
  const resolvedRoot = resolvePath(projectRoot);
  const rootIndexFiles = sourceFiles.filter((f) => {
    const dir = path.dirname(f);
    const base = path.basename(f);
    return dir === resolvedRoot && (base === 'index.ts' || base === 'index.tsx');
  });
  if (rootIndexFiles.length > 0) return rootIndexFiles;

  // 4. All source files
  return [...sourceFiles];
}

// ---------------------------------------------------------------------------
// ProjectScanner
// ---------------------------------------------------------------------------

export class ProjectScanner implements IProjectScanner {
  /**
   * Scans the project and returns a ScanResult containing the ts.Program,
   * all resolved source file paths, and the resolved entrypoints.
   *
   * This method never throws — all errors are returned as ScannerError values.
   */
  scan(options: ScanOptions): Result<ScanResult, ScannerError> {
    try {
      return this.#scanInternal(options);
    } catch (cause) {
      return err(
        makeScannerError(
          'UNKNOWN',
          `Unexpected error during project scan: ${String(cause)}`,
          cause,
        ),
      );
    }
  }

  #scanInternal(options: ScanOptions): Result<ScanResult, ScannerError> {
    const resolvedRoot = resolvePath(options.projectRoot);

    // 1. Locate tsconfig.json
    const tsConfigResult = resolveTsConfigPath(resolvedRoot, options.tsConfigPath);
    if (tsConfigResult.isErr()) return err(tsConfigResult.error);
    const tsConfigPath = tsConfigResult.value;

    // 2. Parse tsconfig
    const parsedResult = parseTsConfig(tsConfigPath, resolvedRoot);
    if (parsedResult.isErr()) return err(parsedResult.error);
    const parsed = parsedResult.value;

    // 3. Collect source files from the parsed config's file list
    //    The TS compiler already resolves globs from include/exclude/files.
    const tsConfigFiles = parsed.fileNames;

    // 4. Also walk the directory for any .ts/.tsx files not picked up by tsconfig
    //    (this handles edge cases where tsconfig.json is in a parent directory).
    const walkResult = walkDirectory(resolvedRoot, {
      extensions: ['.ts', '.tsx'],
      ignore: Array.from(EXCLUDED_DIRS),
    });

    let walkedFiles: readonly string[] = [];
    if (walkResult.isOk()) {
      walkedFiles = walkResult.value;
    }
    // If walk fails we continue with tsconfig files only — not fatal.

    // Merge and deduplicate; prefer tsconfig-provided paths as they are
    // already resolved by the TS compiler.
    const allCandidates = [...new Set([...tsConfigFiles, ...walkedFiles])];
    const sourceFiles = filterSourceFiles(allCandidates, resolvedRoot);

    if (sourceFiles.length === 0) {
      return err(
        makeScannerError(
          'NO_SOURCE_FILES',
          `No .ts/.tsx source files found under project root: ${resolvedRoot}`,
        ),
      );
    }

    // 5. Resolve entrypoints
    const entrypoints = resolveEntrypoints(
      options.entrypoints,
      tsConfigFiles,
      sourceFiles,
      resolvedRoot,
    );

    // 6. Build the ts.Program
    //    We create a compiler host using the tsconfig options so type resolution
    //    works correctly (paths, baseUrl, etc.).
    const compilerOptions: ts.CompilerOptions = {
      ...parsed.options,
      // Ensure declaration files are available for type resolution but we
      // will skip them when iterating source files.
      noEmit: true,
    };

    const program = ts.createProgram({
      rootNames: sourceFiles,
      options: compilerOptions,
      // Use the default compiler host which reads from disk.
      host: ts.createCompilerHost(compilerOptions),
    });

    return ok({
      projectRoot: resolvedRoot,
      tsConfigPath,
      sourceFiles,
      entrypoints,
      program,
    });
  }
}
