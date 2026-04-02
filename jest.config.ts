import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests', '<rootDir>/src'],
  testMatch: ['**/*.test.ts', '**/*.spec.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.json',
      },
    ],
  },
  moduleNameMapper: {
    // Resolve .js extensions to .ts files — required because the source uses
    // Node16 module resolution which mandates explicit .js extensions in
    // import paths, but ts-jest compiles .ts files directly.
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@analyzer/(.*)$': '<rootDir>/src/analyzer/$1',
    '^@graph/(.*)$': '<rootDir>/src/graph/$1',
    '^@server/(.*)$': '<rootDir>/src/server/$1',
    '^@utils/(.*)$': '<rootDir>/src/utils/$1',
    '^@cli/(.*)$': '<rootDir>/src/cli/$1',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    // CLI entry points — wired to Commander.js, not unit-testable in isolation
    '!src/cli/index.ts',
    '!src/cli/analyze.ts',
    '!src/cli/investigate.ts',
    // Express server bootstrap — integration-level, not unit-testable
    '!src/server/index.ts',
    // Barrel re-export files — zero logic, 100% pass-through
    '!src/analyzer/index.ts',
    '!src/graph/index.ts',
    '!src/utils/index.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },
  clearMocks: true,
  restoreMocks: true,
  verbose: true,
};

export default config;
