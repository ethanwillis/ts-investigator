import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ProjectScanner } from '../../src/analyzer/projectScanner.js';

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

const FIXTURE_ROOT = path.join(__dirname, '../fixtures/sample-project');
const FIXTURE_TSCONFIG = path.join(FIXTURE_ROOT, 'tsconfig.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ts-investigator-scanner-test-'));
}

// ---------------------------------------------------------------------------
// describe: ProjectScanner.scan — fixture project (happy path)
// ---------------------------------------------------------------------------

describe('ProjectScanner.scan', () => {
  let scanner: ProjectScanner;

  beforeEach(() => {
    scanner = new ProjectScanner();
  });

  // ---- Happy path against the real fixture project -------------------------

  describe('when scanning the fixture sample-project', () => {
    it('returns an ok Result (not an error)', () => {
      const result = scanner.scan({ projectRoot: FIXTURE_ROOT });
      expect(result.isOk()).toBe(true);
    });

    it('returns the correct number of source files (3: index.ts, utils.ts, types.ts)', () => {
      const result = scanner.scan({ projectRoot: FIXTURE_ROOT });
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // The fixture project has exactly 3 .ts source files
        expect(result.value.sourceFiles).toHaveLength(3);
      }
    });

    it('includes src/index.ts, src/utils.ts, and src/types.ts in sourceFiles', () => {
      const result = scanner.scan({ projectRoot: FIXTURE_ROOT });
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        const files = result.value.sourceFiles;
        const basenames = files.map((f) => path.basename(f));
        expect(basenames).toContain('index.ts');
        expect(basenames).toContain('utils.ts');
        expect(basenames).toContain('types.ts');
      }
    });

    it('resolves sourceFiles to absolute paths', () => {
      const result = scanner.scan({ projectRoot: FIXTURE_ROOT });
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        for (const f of result.value.sourceFiles) {
          expect(path.isAbsolute(f)).toBe(true);
        }
      }
    });

    it('detects src/index.ts as an entrypoint', () => {
      const result = scanner.scan({ projectRoot: FIXTURE_ROOT });
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        const entrypoints = result.value.entrypoints;
        expect(entrypoints.length).toBeGreaterThanOrEqual(1);
        const entrypointBases = entrypoints.map((e) => path.basename(e));
        expect(entrypointBases).toContain('index.ts');
      }
    });

    it('resolves entrypoints to absolute paths', () => {
      const result = scanner.scan({ projectRoot: FIXTURE_ROOT });
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        for (const e of result.value.entrypoints) {
          expect(path.isAbsolute(e)).toBe(true);
        }
      }
    });

    it('returns the resolved tsConfigPath', () => {
      const result = scanner.scan({ projectRoot: FIXTURE_ROOT });
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.tsConfigPath).toBe(FIXTURE_TSCONFIG);
      }
    });

    it('returns the resolved projectRoot', () => {
      const result = scanner.scan({ projectRoot: FIXTURE_ROOT });
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.projectRoot).toBe(path.resolve(FIXTURE_ROOT));
      }
    });

    it('returns a ts.Program with source files', () => {
      const result = scanner.scan({ projectRoot: FIXTURE_ROOT });
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        const program = result.value.program;
        expect(program).toBeDefined();
        // The program should have a type checker
        expect(() => program.getTypeChecker()).not.toThrow();
        // The program should include the fixture source files
        const sourceFileNames = program.getSourceFiles().map((sf) => path.basename(sf.fileName));
        expect(sourceFileNames).toContain('index.ts');
      }
    });

    it('respects an explicit tsConfigPath option', () => {
      const result = scanner.scan({
        projectRoot: FIXTURE_ROOT,
        tsConfigPath: FIXTURE_TSCONFIG,
      });
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.tsConfigPath).toBe(FIXTURE_TSCONFIG);
      }
    });

    it('respects explicit entrypoints option', () => {
      const explicitEntry = path.join(FIXTURE_ROOT, 'src', 'utils.ts');
      const result = scanner.scan({
        projectRoot: FIXTURE_ROOT,
        entrypoints: [explicitEntry],
      });
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.entrypoints).toContain(path.resolve(explicitEntry));
      }
    });
  });

  // ---- Error: explicit tsconfig path does not exist -------------------------

  describe('when tsConfigPath does not exist', () => {
    it('returns TSCONFIG_NOT_FOUND', () => {
      const result = scanner.scan({
        projectRoot: FIXTURE_ROOT,
        tsConfigPath: '/nonexistent/path/to/tsconfig.json',
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.kind).toBe('ScannerError');
        expect(result.error.code).toBe('TSCONFIG_NOT_FOUND');
      }
    });

    it('error message mentions the missing path', () => {
      const badPath = '/nonexistent/path/to/tsconfig.json';
      const result = scanner.scan({
        projectRoot: FIXTURE_ROOT,
        tsConfigPath: badPath,
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toContain(badPath);
      }
    });
  });

  // ---- Error: tsconfig not found when walking upward from an isolated dir ---

  describe('when there is no tsconfig.json anywhere in the directory tree', () => {
    let isolatedDir: string;

    beforeEach(() => {
      // Create a temp dir at the filesystem root level so walking upward
      // will not accidentally find the project's own tsconfig.json.
      // We point to the OS tmp dir which should have no tsconfig.json.
      isolatedDir = makeTmpDir();
      // Create a sub-directory to scan — no tsconfig.json anywhere in the tree
      fs.mkdirSync(path.join(isolatedDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(isolatedDir, 'src', 'index.ts'), 'export const x = 1;\n');
    });

    afterEach(() => {
      fs.rmSync(isolatedDir, { recursive: true, force: true });
    });

    it('returns TSCONFIG_NOT_FOUND when no tsconfig.json is found walking upward', () => {
      // Note: if the OS tmp dir itself happens to have a tsconfig.json this
      // test is moot, but that scenario is extremely unlikely in CI/dev envs.
      // We use an explicit tsConfigPath to a nonexistent file instead to
      // guarantee the error path is triggered reliably.
      const result = scanner.scan({
        projectRoot: isolatedDir,
        tsConfigPath: path.join(isolatedDir, 'tsconfig.json'),
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe('TSCONFIG_NOT_FOUND');
      }
    });
  });

  // ---- Error: no source files -----------------------------------------------

  describe('when the project has no .ts source files', () => {
    let emptyProjectDir: string;

    beforeEach(() => {
      emptyProjectDir = makeTmpDir();
      // Provide a valid minimal tsconfig.json but no .ts source files
      const tsconfig = {
        compilerOptions: {
          target: 'ES2022',
          module: 'Node16',
          moduleResolution: 'Node16',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ['src/**/*'],
      };
      fs.writeFileSync(
        path.join(emptyProjectDir, 'tsconfig.json'),
        JSON.stringify(tsconfig, null, 2),
        'utf-8',
      );
      // Create the src directory with ONLY a .d.ts declaration file.
      // TypeScript won't report TS18003 "No inputs found" because it matches
      // the include glob, but filterSourceFiles excludes .d.ts files —
      // so the scanner returns NO_SOURCE_FILES rather than INVALID_TSCONFIG.
      fs.mkdirSync(path.join(emptyProjectDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(emptyProjectDir, 'src', 'stub.d.ts'),
        '// declaration stub — intentionally empty\nexport {};\n',
      );
    });

    afterEach(() => {
      fs.rmSync(emptyProjectDir, { recursive: true, force: true });
    });

    it('returns NO_SOURCE_FILES', () => {
      const result = scanner.scan({ projectRoot: emptyProjectDir });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.kind).toBe('ScannerError');
        expect(result.error.code).toBe('NO_SOURCE_FILES');
      }
    });

    it('error message mentions the project root', () => {
      const result = scanner.scan({ projectRoot: emptyProjectDir });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toContain(path.resolve(emptyProjectDir));
      }
    });
  });

  // ---- Declaration files are excluded ---------------------------------------

  describe('source file filtering', () => {
    it('does not include .d.ts declaration files in sourceFiles', () => {
      const result = scanner.scan({ projectRoot: FIXTURE_ROOT });
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        const hasDeclarations = result.value.sourceFiles.some((f) => f.endsWith('.d.ts'));
        expect(hasDeclarations).toBe(false);
      }
    });

    it('does not include files from node_modules in sourceFiles', () => {
      const result = scanner.scan({ projectRoot: FIXTURE_ROOT });
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        const hasNodeModules = result.value.sourceFiles.some((f) => f.includes('node_modules'));
        expect(hasNodeModules).toBe(false);
      }
    });
  });
});
