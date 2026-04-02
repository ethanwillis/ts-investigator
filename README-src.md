# ts-investigator

[![npm version](https://img.shields.io/npm/v/ts-investigator.svg)](https://www.npmjs.com/package/ts-investigator)
[![CI](https://github.com/your-org/ts-investigator/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/ts-investigator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/node/v/ts-investigator.svg)](https://nodejs.org)

> Statically analyze any TypeScript project, visualize its dependency graph as an interactive SVG, and explore function signatures through auto-generated parameter forms — all from the command line.

---

## What It Does

`ts-investigator` is a CLI tool that uses the TypeScript compiler API to index every source file in your project, trace the dependency and call relationships between all functions, types, classes, and modules, and serialize the result into a portable graph. The companion `investigate` command then starts a local web server that renders this graph as a fully interactive SVG: click any function node to open an automatically generated parameter form, pre-populated with the correct field types derived from your TypeScript type information — including union members, nested object shapes, optional fields, and subtypes.

---

## Features

- **Full project indexing** — Discovers all TypeScript source files via your existing `tsconfig.json`; no extra configuration needed.
- **Dependency graph generation** — Maps call relationships, import chains, inheritance hierarchies, and type references across your entire codebase.
- **Persistent graph output** — Writes a validated, human-readable `tsinvestigator-graph.json` that can be committed, diffed, or consumed by other tools.
- **Interactive SVG visualization** — Renders the dependency graph as a navigable SVG inside a local web browser using Graphviz WASM (no native binaries required).
- **Auto-generated parameter forms** — Clicking any function node in the graph opens a dynamically built form whose fields precisely reflect the function's TypeScript parameter types, including nested object properties, union variants, optional fields, and primitive subtypes.
- **Zero native dependencies** — Runs entirely in Node.js; uses your project's already-installed TypeScript compiler via a peer dependency.
- **LLM-ready architecture prompt** — The `architect` command analyses the dependency graph for dead code, circular imports, god functions, module coupling instability, and duplicate signatures, then emits a structured Markdown prompt you can paste directly into any LLM to get actionable refactoring recommendations.

---

## Installation

### Global (recommended for use across many projects)

```bash
npm install -g ts-investigator
```

### Local / per-project

```bash
npm install --save-dev ts-investigator
```

When installed locally, invoke it via `npx` or add it to your `package.json` scripts:

```json
{
  "scripts": {
    "analyze": "ts-investigator analyze",
    "investigate": "ts-investigator investigate"
  }
}
```

---

## Usage

### `analyze`

Scans your TypeScript project, builds a dependency graph, and writes the result to disk.

```bash
ts-investigator analyze [options]
```

| Flag | Default | Description |
|---|---|---|
| `-e, --entrypoint <path>` | Auto-detected from `tsconfig.json` | Path to the project entrypoint file(s). Accepts a glob. |
| `-o, --output <path>` | `./tsinvestigator-graph.json` | Where to write the serialized graph JSON. |
| `-p, --project <path>` | `./tsconfig.json` | Path to the `tsconfig.json` to use. |
| `-v, --verbose` | `false` | Enable verbose structured logging. |

**Examples:**

```bash
# Analyze current project with auto-detected entrypoint
ts-investigator analyze

# Specify a custom entrypoint and output path
ts-investigator analyze --entrypoint src/index.ts --output reports/graph.json

# Point to a specific tsconfig
ts-investigator analyze --project packages/core/tsconfig.json --verbose
```

---

### `investigate`

Starts a local web server that renders the graph as an interactive SVG and opens it in your default browser.

```bash
ts-investigator investigate [options]
```

| Flag | Default | Description |
|---|---|---|
| `-g, --graph <path>` | `./tsinvestigator-graph.json` | Path to a previously generated graph JSON file. |
| `-p, --port <number>` | `7777` | Port for the local web server. |
| `--no-open` | — | Suppress automatic browser launch. |
| `-v, --verbose` | `false` | Enable verbose structured logging. |

**Examples:**

```bash
# Start the investigator with default settings (reads tsinvestigator-graph.json)
ts-investigator investigate

# Use a specific graph file on a custom port
ts-investigator investigate --graph reports/graph.json --port 8080

# Start server without auto-opening the browser
ts-investigator investigate --no-open
```

**In the browser:**

1. The SVG renders all nodes (functions, classes, types, interfaces, modules) and their relationships as a directed graph.
2. **Click any function node** to open a side panel with an auto-generated form.
3. Each form field corresponds to a parameter of that function, with the input type derived from the TypeScript type metadata (text inputs for `string`, number inputs for `number`, checkboxes for `boolean`, select dropdowns for union literals, and nested fieldsets for object types).

**Cluster bar (below the header):**

Nodes are grouped into labelled cluster boxes by their connected component. The cluster bar lets you control which clusters are visible — only the entrypoint cluster is shown by default, keeping the initial view focused and uncluttered.

| Cluster type | Colour | Default |
|---|---|---|
| `Entrypoint` | Purple border | **Visible** |
| `Component N` | Grey dashed border | Hidden |
| `Orphaned` | Dimmed dashed border | Hidden |

Click any cluster button to toggle its nodes on or off. The graph re-renders automatically when the selection changes. You must always have at least one cluster visible.

**Node detail panel:**

Clicking any node opens a side panel showing:
- **Node metadata** — kind, file path
- **Parameter form** — for function nodes, an auto-generated form based on TypeScript parameter types
- **Call paths** — all call-graph routes that lead to this node, with parameter type constraints at each step and `↗ Zed` links to open each call site directly in Zed editor
- **Outgoing / Incoming edges** — each edge with kind, line number, source context, and `↗ Zed` link

Clicking a **`×N` badge** on a condensed edge (where N edges connect the same two nodes) opens the edge details directly.

**Navigating the graph:**

| Action | How |
|---|---|
| **Zoom in** | Click `+` button, scroll wheel up, or press `+` / `=` |
| **Zoom out** | Click `−` button, scroll wheel down, or press `-` |
| **Fit to screen** | Click `fit` button or press `F` — scales the graph to fill the viewport |
| **Reset to 100%** | Click `1:1` button or press `0` |
| **Pan** | Click and drag anywhere on the graph background |

The zoom controls are displayed in the bottom-right corner of the graph. The current zoom level is shown as a percentage below the buttons. The graph opens fitted to the screen by default.

**Filter bar (top-right of header):**

Toggle node visibility by kind (`fn`, `class`, `interface`, `type`, `module`) or by file category (`tests`, `fixtures`, `mocks`). Test, fixture, and mock nodes are hidden by default. Nodes whose edges are all hidden by the current filter are dimmed with a dashed border to indicate they are effectively isolated.

---

### `architect`

Analyses a previously generated dependency graph and emits a structured Markdown document — a ready-to-paste LLM prompt — describing concrete refactoring opportunities.

```bash
ts-investigator architect [options]
```

| Flag | Default | Description |
|---|---|---|
| `-g, --graph <path>` | `./tsinvestigator-graph.json` | Path to the graph JSON produced by `analyze`. |
| `-o, --output <path>` | *(stdout)* | Write the prompt to a file instead of printing it. |
| `-c, --context-lines <n>` | `4` | Lines of source code to include above/below each flagged declaration. |
| `--fan-out <n>` | `10` | Fan-out threshold for god-node detection (functions calling ≥ N others). |
| `--fan-in <n>` | `12` | Fan-in threshold for god-node detection (nodes depended on by ≥ N callers). |
| `--min-cycle-length <n>` | `2` | Minimum number of nodes a cycle must contain before it is reported. Default `2` shows all cycles. Set to `3` to suppress intentional 2-node mutual recursion. |
| `--no-dead` | — | Skip dead-code reachability analysis. |
| `--no-cycles` | — | Skip circular-dependency detection. |
| `--no-duplicates` | — | Skip duplicate-signature analysis. |
| `--no-coupling` | — | Skip module-coupling / instability analysis. |
| `-v, --verbose` | `false` | Enable verbose structured logging. |

**Examples:**

```bash
# Full analysis — print prompt to stdout
ts-investigator analyze && ts-investigator architect

# Write prompt to a file and open in your editor
ts-investigator architect --output reports/refactor-prompt.md

# Only analyse cycles and god nodes, include 8 lines of source context
ts-investigator architect --no-dead --no-duplicates --no-coupling --context-lines 8

# Tune thresholds for a smaller codebase
ts-investigator architect --fan-out 6 --fan-in 8

# Suppress 2-node mutual-recursion cycles (often intentional) — only report 3+ node cycles
ts-investigator architect --min-cycle-length 3
```

**What the prompt contains:**

The generated Markdown document is structured so an LLM can reason about it immediately:

1. **Project overview** — symbol counts, edge counts, reachability ratio
2. **Circular import dependencies** — each cycle shown as a node chain with file paths and three standard resolution strategies
3. **Mutual recursion cycles** — call-graph cycles indicating tangled logic (filtered by `--min-cycle-length`)
4. **High-complexity nodes** — god functions / hub types flagged by fan-in and fan-out with source snippets
5. **Dead code candidates** — unreachable symbols grouped by file (test files excluded)
6. **Module coupling** — Martin's Instability metric (I = Ce / (Ca + Ce)) for every module, with verdicts (`stable-abstract`, `stable-concrete`, `unstable`, `balanced`)
7. **Code duplication** — identified by three independent passes:
   - **Identical name** — same function name across ≥ 2 different files
   - **Identical parameter signature** — same canonical TypeScript parameter types across ≥ 2 files (even with different function names)
   - **Identical AST body hash** — structurally identical function bodies detected via DFS pre-order walk of the TypeScript AST with local/parameter names normalised to positional tokens (`$0`, `$1`, …), catching copy-paste duplication even when every variable was renamed
8. **Hub nodes** — the most widely imported symbols (highest change-blast-radius)
9. **Source context** — actual code snippets for the top refactor candidates
10. **Specific questions** — numbered questions for the LLM covering each finding category

**Typical workflow:**

```bash
# 1. Analyse the project
ts-investigator analyze

# 2. Generate the architecture prompt
ts-investigator architect --output docs/refactor-prompt.md

# 3. Open the prompt and paste into your LLM of choice
# 4. Apply the recommendations
# 5. Re-analyse to measure improvement
ts-investigator analyze && ts-investigator architect
```

> **Note:** The `architect` command reads from an existing graph JSON file — it does not re-run the TypeScript compiler. Run `ts-investigator analyze` first (or again after changes) to ensure the graph is up to date.

---

## Configuration

`ts-investigator` works out of the box with no config file required. For persistent defaults, create a `tsinvestigator.config.json` in your project root:

```json
{
  "entrypoint": "src/index.ts",
  "output": "reports/tsinvestigator-graph.json",
  "project": "tsconfig.json",
  "investigate": {
    "port": 7777
  }
}
```

All fields are optional. CLI flags always take precedence over config file values.

---

## Development

### Prerequisites

- **Node.js** >= 18.0.0
- **npm** >= 9.0.0
- **TypeScript** >= 4.7.0 (installed as a peer dependency or dev dependency)

### Setup

```bash
git clone https://github.com/your-org/ts-investigator.git
cd ts-investigator
npm install
```

### Scripts

| Command | Description |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` (CJS + ESM + type declarations). |
| `npm run dev` | Watch mode — recompile on file changes. |
| `npm test` | Run the full test suite via Jest. |
| `npm run test:watch` | Run tests in watch mode. |
| `npm run test:coverage` | Run tests and generate a coverage report. |
| `npm run lint` | Run ESLint across `src/` and `tests/`. |
| `npm run lint:fix` | Auto-fix ESLint violations where possible. |
| `npm run format` | Format all source files with Prettier. |
| `npm run typecheck` | Type-check without emitting output (`tsc --noEmit`). |
| `npm run clean` | Delete the `dist/` directory. |

### Local Development Install (`npm link`)

`npm link` registers the package globally on your machine so you can run `ts-investigator` as a real CLI command while you edit the source — no `npm publish` required.

**One-time setup:**

```bash
# 1. Build the project (the CLI binary is in dist/, which npm link exposes)
npm run build

# 2. Register the package globally via a symlink
npm link
```

After this, the `ts-investigator` command is available anywhere in your terminal:

```bash
ts-investigator --version
ts-investigator analyze --verbose
ts-investigator investigate --port 8080
```

**Development loop** (keeping the global command in sync as you make changes):

```bash
# In one terminal — watch mode recompiles on every save
npm run dev

# In another terminal — your changes are live immediately after each recompile
ts-investigator analyze
```

**Teardown** — when you want to remove the global symlink:

```bash
npm unlink -g ts-investigator
```

> **Note:** `npm link` points directly at the `dist/` directory. Always run `npm run build` (or keep `npm run dev` running) before invoking the CLI, otherwise you will be running stale compiled output.

---

## Architecture Overview

```
src/
├── cli/               # Commander.js command wiring — parses flags, calls library functions
│   ├── index.ts       # CLI bootstrap and program entry point
│   ├── analyze.ts     # `analyze` command handler
│   ├── investigate.ts # `investigate` command handler
│   └── architect.ts   # `architect` command handler
├── analyzer/          # TypeScript compiler API wrappers + architecture analysis
│   ├── projectScanner.ts      # Locates tsconfig.json; enumerates source files
│   ├── typeExtractor.ts       # AST visitor — extracts parameter/return type metadata
│   ├── dependencyGraph.ts     # GraphBuilder — produces an immutable DependencyGraph
│   └── architectureAnalyzer.ts # Reachability, Tarjan SCC, coupling, god-node, duplicate detection
├── graph/             # Shared data model (the contract between analyzer and server)
│   ├── types.ts       # Discriminated union node/edge types (fully readonly)
│   └── serializer.ts  # Zod-validated JSON read/write
├── server/            # `investigate` web server
│   ├── index.ts       # Express server bootstrap + all API routes
│   ├── graphRenderer.ts    # IGraphRenderer interface + Graphviz WASM implementation
│   └── formGenerator.ts    # FieldFactory — maps TS type kinds to form field descriptors
└── utils/
    ├── logger.ts      # Pino structured logger (controlled by --verbose flag)
    └── fsHelpers.ts   # Path resolution and file I/O helpers
```

**Key architectural decisions:**

- The **analyzer** layer has zero knowledge of HTTP or rendering — it only produces a `DependencyGraph`.
- The **server** layer has zero knowledge of how the graph was built — it only consumes the serialized graph JSON.
- `src/graph/types.ts` is the **shared contract** between these two layers.
- The SVG renderer is abstracted behind an `IGraphRenderer` interface so alternative rendering backends can be swapped in without touching server code.
- `neverthrow` `Result<T, E>` types are used across module boundaries to avoid exception-driven control flow.
- The **architect** command operates entirely on the serialized graph JSON — it never touches the TypeScript compiler, making it fast and composable with other tools.

### `architect` — Analysis Algorithms

The architecture analysis is grounded in compiler design theory and program analysis:

| Analysis | Algorithm | What it finds |
|---|---|---|
| Dead code | BFS reachability from entrypoint seed set | Symbols never reachable from any entrypoint |
| Circular imports | Iterative Tarjan's SCC on import-edge subgraph | Import cycles that cause initialisation-order bugs |
| Mutual recursion | Iterative Tarjan's SCC on call-edge subgraph (filtered by `--min-cycle-length`) | Mutually-recursive function clusters |
| God nodes | Fan-in / fan-out degree computation | Functions that do too much or are depended on too widely |
| Module coupling | Martin's Instability: I = Ce / (Ca + Ce) | Modules violating the Stable Abstractions Principle |
| Duplicates — name | Exact string match across files (minus common-name blocklist) | Functions sharing a name that may implement the same logic |
| Duplicates — signature | TypeInfo canonical serialisation + grouping | Missing shared abstractions indicated by identical parameter-type patterns |
| Duplicates — body hash | DFS pre-order AST walk → local name normalisation → djb2 hash | Copy-paste duplication detected even when variables were renamed |
| Hub nodes | Import fan-in ranking | Symbols with the highest change-blast-radius |

---

## Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository and create a feature branch (`git checkout -b feat/my-feature`).
2. Make your changes, ensuring `npm run lint`, `npm test`, and `npm run build` all pass.
3. Write or update tests for any changed behaviour.
4. Update `README.md` if you've added or changed user-visible behaviour.
5. Open a pull request against `main` with a clear description of what was changed and why.

Please open an issue first for significant changes so the approach can be discussed before implementation.

---

## License

[MIT](./LICENSE) © ts-investigator contributors