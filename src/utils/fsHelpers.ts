import * as fs from 'fs';
import * as path from 'path';
import { err, ok, type Result } from 'neverthrow';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export interface FsError {
  readonly kind: 'FsError';
  readonly code: 'NOT_FOUND' | 'PERMISSION_DENIED' | 'PARSE_ERROR' | 'WRITE_ERROR' | 'UNKNOWN';
  readonly message: string;
  readonly path: string;
  readonly cause?: unknown;
}

function makeFsError(
  code: FsError['code'],
  filePath: string,
  message: string,
  cause?: unknown,
): FsError {
  return { kind: 'FsError', code, message, path: filePath, cause };
}

function classifyNodeError(e: unknown, filePath: string): FsError {
  if (e !== null && typeof e === 'object' && 'code' in e) {
    const code = (e as { code: string }).code;
    if (code === 'ENOENT') {
      return makeFsError('NOT_FOUND', filePath, `File not found: ${filePath}`, e);
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return makeFsError('PERMISSION_DENIED', filePath, `Permission denied: ${filePath}`, e);
    }
  }
  return makeFsError('UNKNOWN', filePath, `Unexpected error accessing: ${filePath}`, e);
}

// ---------------------------------------------------------------------------
// Path resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolves a path relative to the current working directory.
 * If the input is already absolute it is returned as-is.
 */
export function resolvePath(...segments: string[]): string {
  return path.resolve(...segments);
}

/**
 * Joins path segments without resolution (does not touch cwd).
 */
export function joinPath(...segments: string[]): string {
  return path.join(...segments);
}

/**
 * Returns the directory name of a given path.
 */
export function dirName(filePath: string): string {
  return path.dirname(filePath);
}

/**
 * Returns the base name (filename + extension) of a given path.
 */
export function baseName(filePath: string, ext?: string): string {
  return path.basename(filePath, ext);
}

/**
 * Returns the file extension of a given path, including the leading dot.
 * Returns an empty string if there is no extension.
 */
export function extName(filePath: string): string {
  return path.extname(filePath);
}

/**
 * Returns true if `child` is inside `parent` (non-inclusive of parent itself).
 */
export function isDescendant(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// ---------------------------------------------------------------------------
// Existence / stat helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the path exists (file or directory).
 */
export function pathExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

/**
 * Returns true if the path exists and is a regular file.
 */
export function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Returns true if the path exists and is a directory.
 */
export function isDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/**
 * Reads a file as a UTF-8 string, returning a typed Result.
 */
export function readTextFile(filePath: string): Result<string, FsError> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return ok(content);
  } catch (e) {
    return err(classifyNodeError(e, filePath));
  }
}

/**
 * Reads and JSON-parses a file, returning a typed Result.
 * The caller is responsible for further validation (e.g. via Zod).
 */
export function readJsonFile(filePath: string): Result<unknown, FsError> {
  const textResult = readTextFile(filePath);
  if (textResult.isErr()) {
    return err(textResult.error);
  }
  try {
    return ok(JSON.parse(textResult.value) as unknown);
  } catch (e) {
    return err(
      makeFsError('PARSE_ERROR', filePath, `Failed to parse JSON in: ${filePath}`, e),
    );
  }
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

/**
 * Ensures the directory containing `filePath` exists, creating it recursively
 * if necessary.
 */
export function ensureDir(dirPath: string): Result<void, FsError> {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    return ok(undefined);
  } catch (e) {
    return err(classifyNodeError(e, dirPath));
  }
}

/**
 * Writes a UTF-8 string to `filePath`, creating parent directories as needed.
 */
export function writeTextFile(filePath: string, content: string): Result<void, FsError> {
  const ensureResult = ensureDir(path.dirname(filePath));
  if (ensureResult.isErr()) {
    return err(ensureResult.error);
  }
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    return ok(undefined);
  } catch (e) {
    return err(makeFsError('WRITE_ERROR', filePath, `Failed to write file: ${filePath}`, e));
  }
}

/**
 * Serializes `data` as pretty-printed JSON and writes it to `filePath`,
 * creating parent directories as needed.
 */
export function writeJsonFile(filePath: string, data: unknown): Result<void, FsError> {
  let serialized: string;
  try {
    serialized = JSON.stringify(data, null, 2);
  } catch (e) {
    return err(
      makeFsError('WRITE_ERROR', filePath, `Failed to serialize data to JSON for: ${filePath}`, e),
    );
  }
  return writeTextFile(filePath, serialized);
}

// ---------------------------------------------------------------------------
// Directory traversal helpers
// ---------------------------------------------------------------------------

export interface WalkOptions {
  /** File extensions to include (with leading dot, e.g. ['.ts']). Include all if omitted. */
  readonly extensions?: readonly string[];
  /** Directory names to skip entirely (e.g. ['node_modules', 'dist']). */
  readonly ignore?: readonly string[];
  /** Maximum traversal depth. Unlimited if omitted. */
  readonly maxDepth?: number;
}

/**
 * Recursively walks a directory tree and returns all file paths matching the
 * given options.
 */
export function walkDirectory(
  rootDir: string,
  options: WalkOptions = {},
): Result<readonly string[], FsError> {
  const results: string[] = [];
  const ignore = new Set(options.ignore ?? ['node_modules', 'dist', '.git', 'coverage']);

  function walk(dir: string, depth: number): Result<void, FsError> {
    if (options.maxDepth !== undefined && depth > options.maxDepth) {
      return ok(undefined);
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return err(classifyNodeError(e, dir));
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!ignore.has(entry.name)) {
          const subResult = walk(fullPath, depth + 1);
          if (subResult.isErr()) {
            return err(subResult.error);
          }
        }
        continue;
      }

      if (entry.isFile()) {
        if (
          options.extensions === undefined ||
          options.extensions.includes(path.extname(entry.name))
        ) {
          results.push(fullPath);
        }
      }
    }

    return ok(undefined);
  }

  const walkResult = walk(rootDir, 0);
  if (walkResult.isErr()) {
    return err(walkResult.error);
  }

  return ok(results);
}

/**
 * Searches for a file by name, walking up the directory tree from `startDir`.
 * Returns the absolute path of the first match, or null if not found.
 */
export function findFileUpward(startDir: string, fileName: string): string | null {
  let current = path.resolve(startDir);

  while (true) {
    const candidate = path.join(current, fileName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      // Reached filesystem root
      return null;
    }

    current = parent;
  }
}
