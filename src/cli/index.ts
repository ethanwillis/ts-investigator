#!/usr/bin/env node
import { Command } from 'commander';
import { runAnalyze } from './analyze.js';
import { runInvestigate } from './investigate.js';
import { runArchitect } from './architect.js';

const program = new Command();

program
  .name('ts-investigator')
  .description('Analyze TypeScript projects and explore their dependency graphs interactively')
  .version('0.1.0');

// ---------------------------------------------------------------------------
// analyze subcommand
// ---------------------------------------------------------------------------

program
  .command('analyze')
  .description('Scan a TypeScript project and output a dependency graph JSON file')
  .option('-e, --entrypoint <path>', 'Path to the project entrypoint (auto-detected if omitted)')
  .option('-o, --output <path>', 'Output path for the graph JSON', './tsinvestigator-graph.json')
  .option('-p, --project <path>', 'Path to tsconfig.json', './tsconfig.json')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .action((opts: { entrypoint?: string; output: string; project: string; verbose: boolean }) => {
    runAnalyze({
      ...(opts.entrypoint !== undefined ? { entrypoint: opts.entrypoint } : {}),
      output: opts.output,
      project: opts.project,
      verbose: opts.verbose,
    }).catch((err: unknown) => {
      console.error(err); // eslint-disable-line no-console
      process.exit(1);
    });
  });

// ---------------------------------------------------------------------------
// investigate subcommand
// ---------------------------------------------------------------------------

program
  .command('investigate')
  .description('Start the interactive dependency graph web UI')
  .option('-g, --graph <path>', 'Path to graph JSON file', './tsinvestigator-graph.json')
  .option('-p, --port <number>', 'Port for the web server', '7777')
  .option('--no-open', 'Suppress automatic browser launch')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .action((opts: { graph: string; port: string; open: boolean; verbose: boolean }) => {
    runInvestigate({
      graph: opts.graph,
      port: parseInt(opts.port, 10),
      open: opts.open,
      verbose: opts.verbose,
    }).catch((err: unknown) => {
      console.error(err); // eslint-disable-line no-console
      process.exit(1);
    });
  });

// ---------------------------------------------------------------------------
// architect subcommand
// ---------------------------------------------------------------------------

program
  .command('architect')
  .description(
    'Analyse an existing dependency graph and emit an LLM-friendly Markdown prompt ' +
      'describing refactoring opportunities (dead code, cycles, god nodes, duplication, coupling)',
  )
  .option(
    '-g, --graph <path>',
    'Path to the graph JSON produced by `analyze`',
    './tsinvestigator-graph.json',
  )
  .option('-o, --output <path>', 'Write the prompt to a file instead of stdout')
  .option('-c, --context-lines <n>', 'Source lines of context to include per flagged node', '4')
  .option('--fan-out <n>', 'Fan-out threshold for god-node detection', '10')
  .option('--fan-in <n>', 'Fan-in threshold for god-node detection', '12')
  .option(
    '--min-cycle-length <n>',
    'Minimum cycle length to report (set to 3 to suppress 2-node mutual recursion)',
    '2',
  )
  .option('--no-dead', 'Skip dead-code analysis')
  .option('--no-cycles', 'Skip circular-dependency analysis')
  .option('--no-duplicates', 'Skip duplicate-signature analysis')
  .option('--no-coupling', 'Skip module-coupling analysis')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .action(
    (opts: {
      graph: string;
      output?: string;
      contextLines: string;
      fanOut: string;
      fanIn: string;
      minCycleLength: string;
      dead: boolean;
      cycles: boolean;
      duplicates: boolean;
      coupling: boolean;
      verbose: boolean;
    }) => {
      runArchitect({
        graph: opts.graph,
        ...(opts.output !== undefined ? { output: opts.output } : {}),
        contextLines: parseInt(opts.contextLines, 10),
        fanOut: parseInt(opts.fanOut, 10),
        fanIn: parseInt(opts.fanIn, 10),
        minCycleLength: parseInt(opts.minCycleLength, 10),
        noDead: !opts.dead,
        noCycles: !opts.cycles,
        noDuplicates: !opts.duplicates,
        noCoupling: !opts.coupling,
        verbose: opts.verbose,
      }).catch((err: unknown) => {
        console.error(err); // eslint-disable-line no-console
        process.exit(1);
      });
    },
  );

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
