"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const fsHelpers_js_1 = require("../../src/utils/fsHelpers.js");
const logger_js_1 = require("../../src/utils/logger.js");
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ts-inv-fshelpers-test-'));
}
// ---------------------------------------------------------------------------
// resolvePath
// ---------------------------------------------------------------------------
describe('resolvePath', () => {
    it('returns an absolute path', () => {
        const result = (0, fsHelpers_js_1.resolvePath)('some/relative/path');
        expect(path.isAbsolute(result)).toBe(true);
    });
    it('returns an already-absolute path unchanged', () => {
        const abs = '/tmp/something';
        const result = (0, fsHelpers_js_1.resolvePath)(abs);
        expect(result).toBe(abs);
    });
    it('joins multiple segments', () => {
        const result = (0, fsHelpers_js_1.resolvePath)('/a', 'b', 'c');
        expect(result).toBe('/a/b/c');
    });
});
// ---------------------------------------------------------------------------
// joinPath
// ---------------------------------------------------------------------------
describe('joinPath', () => {
    it('joins path segments without resolving against cwd', () => {
        const result = (0, fsHelpers_js_1.joinPath)('a', 'b', 'c.ts');
        expect(result).toBe(path.join('a', 'b', 'c.ts'));
    });
    it('handles absolute segments', () => {
        const result = (0, fsHelpers_js_1.joinPath)('/root', 'sub', 'file.ts');
        expect(result).toBe('/root/sub/file.ts');
    });
});
// ---------------------------------------------------------------------------
// dirName
// ---------------------------------------------------------------------------
describe('dirName', () => {
    it('returns the directory part of a path', () => {
        expect((0, fsHelpers_js_1.dirName)('/a/b/c.ts')).toBe('/a/b');
    });
    it('returns "." for a bare filename', () => {
        expect((0, fsHelpers_js_1.dirName)('file.ts')).toBe('.');
    });
});
// ---------------------------------------------------------------------------
// baseName
// ---------------------------------------------------------------------------
describe('baseName', () => {
    it('returns the filename from a path', () => {
        expect((0, fsHelpers_js_1.baseName)('/a/b/file.ts')).toBe('file.ts');
    });
    it('strips the extension when provided', () => {
        expect((0, fsHelpers_js_1.baseName)('/a/b/file.ts', '.ts')).toBe('file');
    });
    it('returns just the name for a bare filename', () => {
        expect((0, fsHelpers_js_1.baseName)('hello.txt')).toBe('hello.txt');
    });
});
// ---------------------------------------------------------------------------
// extName
// ---------------------------------------------------------------------------
describe('extName', () => {
    it('returns the extension including the dot', () => {
        expect((0, fsHelpers_js_1.extName)('file.ts')).toBe('.ts');
    });
    it('returns an empty string when there is no extension', () => {
        expect((0, fsHelpers_js_1.extName)('Makefile')).toBe('');
    });
    it('returns .json for a json file', () => {
        expect((0, fsHelpers_js_1.extName)('/a/b/config.json')).toBe('.json');
    });
});
// ---------------------------------------------------------------------------
// isDescendant
// ---------------------------------------------------------------------------
describe('isDescendant', () => {
    it('returns true when child is inside parent', () => {
        expect((0, fsHelpers_js_1.isDescendant)('/a/b', '/a/b/c/d.ts')).toBe(true);
    });
    it('returns false when child equals parent', () => {
        expect((0, fsHelpers_js_1.isDescendant)('/a/b', '/a/b')).toBe(false);
    });
    it('returns false when child is outside parent', () => {
        expect((0, fsHelpers_js_1.isDescendant)('/a/b', '/a/c/d.ts')).toBe(false);
    });
    it('returns false when child is a parent of the given parent', () => {
        expect((0, fsHelpers_js_1.isDescendant)('/a/b/c', '/a/b')).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// pathExists
// ---------------------------------------------------------------------------
describe('pathExists', () => {
    let tmpDir;
    beforeEach(() => {
        tmpDir = makeTmpDir();
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    it('returns true for an existing directory', () => {
        expect((0, fsHelpers_js_1.pathExists)(tmpDir)).toBe(true);
    });
    it('returns true for an existing file', () => {
        const f = path.join(tmpDir, 'file.txt');
        fs.writeFileSync(f, 'hello');
        expect((0, fsHelpers_js_1.pathExists)(f)).toBe(true);
    });
    it('returns false for a non-existent path', () => {
        expect((0, fsHelpers_js_1.pathExists)(path.join(tmpDir, 'nonexistent'))).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// isFile
// ---------------------------------------------------------------------------
describe('isFile', () => {
    let tmpDir;
    beforeEach(() => {
        tmpDir = makeTmpDir();
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    it('returns true for a regular file', () => {
        const f = path.join(tmpDir, 'file.txt');
        fs.writeFileSync(f, 'content');
        expect((0, fsHelpers_js_1.isFile)(f)).toBe(true);
    });
    it('returns false for a directory', () => {
        expect((0, fsHelpers_js_1.isFile)(tmpDir)).toBe(false);
    });
    it('returns false for a non-existent path (no throw)', () => {
        expect((0, fsHelpers_js_1.isFile)(path.join(tmpDir, 'no-such-file.txt'))).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// isDirectory
// ---------------------------------------------------------------------------
describe('isDirectory', () => {
    let tmpDir;
    beforeEach(() => {
        tmpDir = makeTmpDir();
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    it('returns true for a directory', () => {
        expect((0, fsHelpers_js_1.isDirectory)(tmpDir)).toBe(true);
    });
    it('returns false for a regular file', () => {
        const f = path.join(tmpDir, 'file.txt');
        fs.writeFileSync(f, 'content');
        expect((0, fsHelpers_js_1.isDirectory)(f)).toBe(false);
    });
    it('returns false for a non-existent path (no throw)', () => {
        expect((0, fsHelpers_js_1.isDirectory)(path.join(tmpDir, 'no-such-dir'))).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// readTextFile
// ---------------------------------------------------------------------------
describe('readTextFile', () => {
    let tmpDir;
    beforeEach(() => {
        tmpDir = makeTmpDir();
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    it('reads an existing file and returns ok', () => {
        const f = path.join(tmpDir, 'hello.txt');
        fs.writeFileSync(f, 'hello world');
        const result = (0, fsHelpers_js_1.readTextFile)(f);
        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
            expect(result.value).toBe('hello world');
        }
    });
    it('returns NOT_FOUND error for a missing file', () => {
        const result = (0, fsHelpers_js_1.readTextFile)(path.join(tmpDir, 'missing.txt'));
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
            expect(result.error.kind).toBe('FsError');
            expect(result.error.code).toBe('NOT_FOUND');
        }
    });
    it('error path contains the file path', () => {
        const missingPath = path.join(tmpDir, 'no-file.txt');
        const result = (0, fsHelpers_js_1.readTextFile)(missingPath);
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
            expect(result.error.path).toBe(missingPath);
        }
    });
    it('reads UTF-8 content including unicode characters', () => {
        const f = path.join(tmpDir, 'unicode.txt');
        fs.writeFileSync(f, '日本語テスト', 'utf-8');
        const result = (0, fsHelpers_js_1.readTextFile)(f);
        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
            expect(result.value).toBe('日本語テスト');
        }
    });
});
// ---------------------------------------------------------------------------
// readJsonFile
// ---------------------------------------------------------------------------
describe('readJsonFile', () => {
    let tmpDir;
    beforeEach(() => {
        tmpDir = makeTmpDir();
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    it('reads and parses a valid JSON file', () => {
        const f = path.join(tmpDir, 'data.json');
        fs.writeFileSync(f, JSON.stringify({ key: 'value', n: 42 }));
        const result = (0, fsHelpers_js_1.readJsonFile)(f);
        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
            const data = result.value;
            expect(data.key).toBe('value');
            expect(data.n).toBe(42);
        }
    });
    it('returns NOT_FOUND error when file does not exist', () => {
        const result = (0, fsHelpers_js_1.readJsonFile)(path.join(tmpDir, 'missing.json'));
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
            expect(result.error.code).toBe('NOT_FOUND');
        }
    });
    it('returns PARSE_ERROR for a file with invalid JSON', () => {
        const f = path.join(tmpDir, 'bad.json');
        fs.writeFileSync(f, '{bad json:::}', 'utf-8');
        const result = (0, fsHelpers_js_1.readJsonFile)(f);
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
            expect(result.error.kind).toBe('FsError');
            expect(result.error.code).toBe('PARSE_ERROR');
        }
    });
    it('PARSE_ERROR path contains the file path', () => {
        const f = path.join(tmpDir, 'bad.json');
        fs.writeFileSync(f, 'not json', 'utf-8');
        const result = (0, fsHelpers_js_1.readJsonFile)(f);
        if (result.isErr()) {
            expect(result.error.path).toBe(f);
        }
    });
    it('parses arrays', () => {
        const f = path.join(tmpDir, 'arr.json');
        fs.writeFileSync(f, JSON.stringify([1, 2, 3]));
        const result = (0, fsHelpers_js_1.readJsonFile)(f);
        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
            expect(result.value).toEqual([1, 2, 3]);
        }
    });
});
// ---------------------------------------------------------------------------
// ensureDir
// ---------------------------------------------------------------------------
describe('ensureDir', () => {
    let tmpDir;
    beforeEach(() => {
        tmpDir = makeTmpDir();
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    it('creates a new directory', () => {
        const newDir = path.join(tmpDir, 'new-dir');
        const result = (0, fsHelpers_js_1.ensureDir)(newDir);
        expect(result.isOk()).toBe(true);
        expect(fs.existsSync(newDir)).toBe(true);
    });
    it('creates nested directories recursively', () => {
        const deepDir = path.join(tmpDir, 'a', 'b', 'c', 'd');
        const result = (0, fsHelpers_js_1.ensureDir)(deepDir);
        expect(result.isOk()).toBe(true);
        expect(fs.existsSync(deepDir)).toBe(true);
    });
    it('succeeds if directory already exists', () => {
        const result = (0, fsHelpers_js_1.ensureDir)(tmpDir);
        expect(result.isOk()).toBe(true);
    });
    it('returns an error when path conflicts with an existing file', () => {
        const conflictFile = path.join(tmpDir, 'conflict');
        fs.writeFileSync(conflictFile, 'data');
        // Trying to make a directory at the same path as a file in a subdirectory
        const badDir = path.join(conflictFile, 'sub');
        const result = (0, fsHelpers_js_1.ensureDir)(badDir);
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
            expect(result.error.kind).toBe('FsError');
        }
    });
});
// ---------------------------------------------------------------------------
// writeTextFile
// ---------------------------------------------------------------------------
describe('writeTextFile', () => {
    let tmpDir;
    beforeEach(() => {
        tmpDir = makeTmpDir();
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    it('writes a file and returns ok', () => {
        const f = path.join(tmpDir, 'output.txt');
        const result = (0, fsHelpers_js_1.writeTextFile)(f, 'hello');
        expect(result.isOk()).toBe(true);
        expect(fs.readFileSync(f, 'utf-8')).toBe('hello');
    });
    it('creates parent directories if they do not exist', () => {
        const f = path.join(tmpDir, 'sub', 'deep', 'output.txt');
        const result = (0, fsHelpers_js_1.writeTextFile)(f, 'content');
        expect(result.isOk()).toBe(true);
        expect(fs.existsSync(f)).toBe(true);
    });
    it('overwrites an existing file', () => {
        const f = path.join(tmpDir, 'file.txt');
        fs.writeFileSync(f, 'old content');
        (0, fsHelpers_js_1.writeTextFile)(f, 'new content');
        expect(fs.readFileSync(f, 'utf-8')).toBe('new content');
    });
    it('returns an error when parent dir creation fails', () => {
        const conflictFile = path.join(tmpDir, 'notadir');
        fs.writeFileSync(conflictFile, 'data');
        const f = path.join(conflictFile, 'output.txt');
        const result = (0, fsHelpers_js_1.writeTextFile)(f, 'data');
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
            expect(result.error.kind).toBe('FsError');
        }
    });
});
// ---------------------------------------------------------------------------
// writeJsonFile
// ---------------------------------------------------------------------------
describe('writeJsonFile', () => {
    let tmpDir;
    beforeEach(() => {
        tmpDir = makeTmpDir();
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    it('writes JSON to a file and returns ok', () => {
        const f = path.join(tmpDir, 'data.json');
        const data = { x: 1, y: 'hello' };
        const result = (0, fsHelpers_js_1.writeJsonFile)(f, data);
        expect(result.isOk()).toBe(true);
        const parsed = JSON.parse(fs.readFileSync(f, 'utf-8'));
        expect(parsed).toEqual(data);
    });
    it('produces pretty-printed JSON (indented)', () => {
        const f = path.join(tmpDir, 'pretty.json');
        (0, fsHelpers_js_1.writeJsonFile)(f, { a: 1 });
        const content = fs.readFileSync(f, 'utf-8');
        expect(content).toContain('\n');
        expect(content).toContain('  ');
    });
    it('creates parent directories if needed', () => {
        const f = path.join(tmpDir, 'nested', 'data.json');
        const result = (0, fsHelpers_js_1.writeJsonFile)(f, { ok: true });
        expect(result.isOk()).toBe(true);
        expect(fs.existsSync(f)).toBe(true);
    });
    it('returns an error when the path is invalid', () => {
        const conflictFile = path.join(tmpDir, 'notadir');
        fs.writeFileSync(conflictFile, 'x');
        const result = (0, fsHelpers_js_1.writeJsonFile)(path.join(conflictFile, 'data.json'), {});
        expect(result.isErr()).toBe(true);
    });
    it('handles arrays', () => {
        const f = path.join(tmpDir, 'arr.json');
        (0, fsHelpers_js_1.writeJsonFile)(f, [1, 2, 3]);
        const parsed = JSON.parse(fs.readFileSync(f, 'utf-8'));
        expect(parsed).toEqual([1, 2, 3]);
    });
});
// ---------------------------------------------------------------------------
// walkDirectory
// ---------------------------------------------------------------------------
describe('walkDirectory', () => {
    let tmpDir;
    beforeEach(() => {
        tmpDir = makeTmpDir();
        // Build a small tree:
        //   tmpDir/
        //     a.ts
        //     b.ts
        //     sub/
        //       c.ts
        //       d.js
        //     node_modules/
        //       ignored.ts
        fs.writeFileSync(path.join(tmpDir, 'a.ts'), '');
        fs.writeFileSync(path.join(tmpDir, 'b.ts'), '');
        fs.mkdirSync(path.join(tmpDir, 'sub'));
        fs.writeFileSync(path.join(tmpDir, 'sub', 'c.ts'), '');
        fs.writeFileSync(path.join(tmpDir, 'sub', 'd.js'), '');
        fs.mkdirSync(path.join(tmpDir, 'node_modules'));
        fs.writeFileSync(path.join(tmpDir, 'node_modules', 'ignored.ts'), '');
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    it('returns all files when no options are given', () => {
        const result = (0, fsHelpers_js_1.walkDirectory)(tmpDir, { ignore: [] });
        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
            expect(result.value.length).toBeGreaterThanOrEqual(4);
        }
    });
    it('filters by extension when extensions option is given', () => {
        const result = (0, fsHelpers_js_1.walkDirectory)(tmpDir, { extensions: ['.ts'], ignore: [] });
        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
            const files = result.value;
            expect(files.every((f) => f.endsWith('.ts'))).toBe(true);
            // node_modules/ignored.ts is included when ignore is []
            // sub/c.ts and a.ts and b.ts
            expect(files.some((f) => f.endsWith('a.ts'))).toBe(true);
            expect(files.some((f) => f.endsWith('b.ts'))).toBe(true);
            expect(files.some((f) => f.endsWith('c.ts'))).toBe(true);
        }
    });
    it('ignores directories listed in ignore option', () => {
        const result = (0, fsHelpers_js_1.walkDirectory)(tmpDir, {
            extensions: ['.ts'],
            ignore: ['node_modules'],
        });
        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
            const hasNodeModules = result.value.some((f) => f.includes('node_modules'));
            expect(hasNodeModules).toBe(false);
        }
    });
    it('ignores node_modules by default', () => {
        const result = (0, fsHelpers_js_1.walkDirectory)(tmpDir, { extensions: ['.ts'] });
        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
            const hasNodeModules = result.value.some((f) => f.includes('node_modules'));
            expect(hasNodeModules).toBe(false);
        }
    });
    it('respects maxDepth option', () => {
        const result = (0, fsHelpers_js_1.walkDirectory)(tmpDir, { extensions: ['.ts'], ignore: [], maxDepth: 0 });
        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
            // Depth 0 only includes files in the root — no recursion into sub/
            const hasSub = result.value.some((f) => f.includes(`${path.sep}sub${path.sep}`));
            expect(hasSub).toBe(false);
        }
    });
    it('returns an error when the directory does not exist', () => {
        const result = (0, fsHelpers_js_1.walkDirectory)(path.join(tmpDir, 'nonexistent'));
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
            expect(result.error.kind).toBe('FsError');
        }
    });
    it('returns all .ts files at depth 1 (maxDepth: 1)', () => {
        const result = (0, fsHelpers_js_1.walkDirectory)(tmpDir, {
            extensions: ['.ts'],
            ignore: ['node_modules'],
            maxDepth: 1,
        });
        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
            expect(result.value.some((f) => path.basename(f) === 'a.ts')).toBe(true);
            expect(result.value.some((f) => path.basename(f) === 'c.ts')).toBe(true);
        }
    });
});
// ---------------------------------------------------------------------------
// findFileUpward
// ---------------------------------------------------------------------------
describe('findFileUpward', () => {
    let tmpDir;
    beforeEach(() => {
        tmpDir = makeTmpDir();
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    it('finds a file in the start directory', () => {
        const target = path.join(tmpDir, 'tsconfig.json');
        fs.writeFileSync(target, '{}');
        const found = (0, fsHelpers_js_1.findFileUpward)(tmpDir, 'tsconfig.json');
        expect(found).toBe(target);
    });
    it('finds a file in a parent directory', () => {
        const child = path.join(tmpDir, 'src', 'nested');
        fs.mkdirSync(child, { recursive: true });
        const target = path.join(tmpDir, 'tsconfig.json');
        fs.writeFileSync(target, '{}');
        const found = (0, fsHelpers_js_1.findFileUpward)(child, 'tsconfig.json');
        expect(found).toBe(target);
    });
    it('returns null when the file is not found anywhere', () => {
        // Use a deeply nested temp dir where the file won't exist
        const child = path.join(tmpDir, 'a', 'b', 'c');
        fs.mkdirSync(child, { recursive: true });
        // Search for a file with a very unlikely name
        const found = (0, fsHelpers_js_1.findFileUpward)(child, '__nonexistent_sentinel_file_xyz__.json');
        expect(found).toBeNull();
    });
    it('returns an absolute path', () => {
        const target = path.join(tmpDir, 'package.json');
        fs.writeFileSync(target, '{}');
        const found = (0, fsHelpers_js_1.findFileUpward)(tmpDir, 'package.json');
        expect(found).not.toBeNull();
        if (found !== null) {
            expect(path.isAbsolute(found)).toBe(true);
        }
    });
});
// ---------------------------------------------------------------------------
// logger
// ---------------------------------------------------------------------------
describe('createLogger', () => {
    it('creates a logger with default options', () => {
        const logger = (0, logger_js_1.createLogger)();
        expect(logger).toBeDefined();
        expect(typeof logger.info).toBe('function');
    });
    it('creates a logger with level "debug"', () => {
        const logger = (0, logger_js_1.createLogger)({ level: 'debug' });
        expect(logger.level).toBe('debug');
    });
    it('creates a logger with level "error"', () => {
        const logger = (0, logger_js_1.createLogger)({ level: 'error' });
        expect(logger.level).toBe('error');
    });
    it('creates a silent logger', () => {
        const logger = (0, logger_js_1.createLogger)({ level: 'silent' });
        expect(logger.level).toBe('silent');
    });
    it('creates a named logger', () => {
        const logger = (0, logger_js_1.createLogger)({ level: 'silent', pretty: false, name: 'test-module' });
        expect(logger).toBeDefined();
    });
    it('creates a logger with pretty: false (JSON mode)', () => {
        const logger = (0, logger_js_1.createLogger)({ level: 'silent', pretty: false });
        expect(logger).toBeDefined();
        expect(logger.level).toBe('silent');
    });
    it('creates a logger with pretty: true (pino-pretty transport)', () => {
        // pretty: true uses pino-pretty transport; just verify it does not throw
        expect(() => (0, logger_js_1.createLogger)({ level: 'silent', pretty: true })).not.toThrow();
    });
    it('creates a logger with pretty: true and a name', () => {
        expect(() => (0, logger_js_1.createLogger)({ level: 'silent', pretty: true, name: 'my-module' })).not.toThrow();
    });
});
describe('createSilentLogger', () => {
    it('returns a logger with level "silent"', () => {
        const logger = (0, logger_js_1.createSilentLogger)();
        expect(logger.level).toBe('silent');
    });
    it('does not throw when logging is called on a silent logger', () => {
        const logger = (0, logger_js_1.createSilentLogger)();
        expect(() => logger.info('should be silenced')).not.toThrow();
        expect(() => logger.error('silenced error')).not.toThrow();
    });
});
describe('setLogLevel', () => {
    it('changes the log level on an existing logger', () => {
        const logger = (0, logger_js_1.createSilentLogger)();
        (0, logger_js_1.setLogLevel)(logger, 'warn');
        expect(logger.level).toBe('warn');
    });
    it('can set any valid log level', () => {
        const levels = ['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'];
        const logger = (0, logger_js_1.createSilentLogger)();
        for (const level of levels) {
            (0, logger_js_1.setLogLevel)(logger, level);
            expect(logger.level).toBe(level);
        }
    });
});
describe('createChildLogger', () => {
    it('returns a child logger derived from the parent', () => {
        const parent = (0, logger_js_1.createSilentLogger)();
        const child = (0, logger_js_1.createChildLogger)(parent, 'child-module');
        expect(child).toBeDefined();
        expect(typeof child.info).toBe('function');
    });
    it('child logger has the same level as parent by default', () => {
        const parent = (0, logger_js_1.createLogger)({ level: 'warn', pretty: false });
        const child = (0, logger_js_1.createChildLogger)(parent, 'child');
        // Child loggers inherit level from parent
        expect(child.level).toBe('warn');
    });
    it('does not throw when logging on a child logger', () => {
        const parent = (0, logger_js_1.createSilentLogger)();
        const child = (0, logger_js_1.createChildLogger)(parent, 'test');
        expect(() => child.info('test message')).not.toThrow();
    });
});
//# sourceMappingURL=fsHelpers.test.js.map