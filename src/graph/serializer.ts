import { z } from 'zod';
import { ok, err, type Result } from 'neverthrow';
import { writeJsonFile, readJsonFile } from '../utils/fsHelpers.js';
import type { DependencyGraph, GraphNode, GraphEdge } from './types.js';

// ---------------------------------------------------------------------------
// SerializerError
// ---------------------------------------------------------------------------

export interface SerializerError {
  readonly kind: 'SerializerError';
  readonly code: 'VALIDATION_FAILED' | 'SERIALIZE_ERROR' | 'IO_ERROR';
  readonly message: string;
  readonly cause?: unknown;
}

function makeSerializerError(
  code: SerializerError['code'],
  message: string,
  cause?: unknown,
): SerializerError {
  return { kind: 'SerializerError', code, message, cause };
}

// ---------------------------------------------------------------------------
// Zod Schemas
//
// IMPORTANT: Recursive schemas (TypeInfoSchema, ParameterInfoSchema,
// PropertyInfoSchema) are typed as `z.ZodTypeAny` to break circular reference
// typing. This is also necessary because `exactOptionalPropertyTypes: true` in
// tsconfig makes `z.optional()` incompatible with `field?: T` (Zod infers
// `T | undefined` whereas the flag requires the key to be absent, not
// `undefined`). Individual node/edge schemas are left un-annotated so
// TypeScript infers their concrete ZodObject types, keeping them compatible
// with `z.discriminatedUnion()`. Type assertions are applied only at the
// parse boundary.
// ---------------------------------------------------------------------------

// Declared first; its lazy factory closure refers to ParameterInfoSchema and
// PropertyInfoSchema, which are module-level constants initialized before any
// parse call can occur.
// eslint-disable-next-line prefer-const
let TypeInfoSchema: z.ZodTypeAny;

// eslint-disable-next-line prefer-const
let ParameterInfoSchema: z.ZodTypeAny;

// eslint-disable-next-line prefer-const
let PropertyInfoSchema: z.ZodTypeAny;

TypeInfoSchema = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('primitive'),
      name: z.union([
        z.literal('string'),
        z.literal('number'),
        z.literal('boolean'),
        z.literal('null'),
        z.literal('undefined'),
        z.literal('void'),
        z.literal('never'),
        z.literal('unknown'),
        z.literal('any'),
      ]),
    }),
    z.object({
      kind: z.literal('literal'),
      value: z.union([z.string(), z.number(), z.boolean()]),
    }),
    z.object({
      kind: z.literal('array'),
      elementType: TypeInfoSchema,
    }),
    z.object({
      kind: z.literal('tuple'),
      elements: z.array(TypeInfoSchema),
    }),
    z.object({
      kind: z.literal('union'),
      members: z.array(TypeInfoSchema),
    }),
    z.object({
      kind: z.literal('intersection'),
      members: z.array(TypeInfoSchema),
    }),
    z.object({
      kind: z.literal('object'),
      properties: z.array(PropertyInfoSchema),
    }),
    z.object({
      kind: z.literal('reference'),
      name: z.string(),
      typeArguments: z.array(TypeInfoSchema),
    }),
    z.object({
      kind: z.literal('function'),
      parameters: z.array(ParameterInfoSchema),
      returnType: TypeInfoSchema,
    }),
    z.object({
      kind: z.literal('unknown'),
      raw: z.string(),
    }),
  ]),
);

ParameterInfoSchema = z.lazy(() =>
  z.object({
    name: z.string(),
    typeInfo: TypeInfoSchema,
    isOptional: z.boolean(),
    isRest: z.boolean(),
    defaultValue: z.string().optional(),
  }),
);

PropertyInfoSchema = z.lazy(() =>
  z.object({
    name: z.string(),
    typeInfo: TypeInfoSchema,
    isOptional: z.boolean(),
    isReadonly: z.boolean(),
    jsdoc: z.string().optional(),
  }),
);

// ---------------------------------------------------------------------------
// Node Schemas — no explicit ZodType<X> annotation so TypeScript infers the
// concrete ZodObject type, which is required by z.discriminatedUnion().
// ---------------------------------------------------------------------------

const FunctionNodeSchema = z.object({
  kind: z.literal('function'),
  id: z.string(),
  name: z.string(),
  filePath: z.string(),
  line: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
  isAsync: z.boolean(),
  isExported: z.boolean(),
  parameters: z.array(ParameterInfoSchema),
  returnType: TypeInfoSchema,
  jsdoc: z.string().optional(),
});

const ClassNodeSchema = z.object({
  kind: z.literal('class'),
  id: z.string(),
  name: z.string(),
  filePath: z.string(),
  line: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
  isExported: z.boolean(),
  superClass: z.string().optional(),
  interfaces: z.array(z.string()),
  methods: z.array(FunctionNodeSchema),
  properties: z.array(PropertyInfoSchema),
});

const InterfaceNodeSchema = z.object({
  kind: z.literal('interface'),
  id: z.string(),
  name: z.string(),
  filePath: z.string(),
  line: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
  isExported: z.boolean(),
  extends: z.array(z.string()),
  properties: z.array(PropertyInfoSchema),
});

const TypeAliasNodeSchema = z.object({
  kind: z.literal('typeAlias'),
  id: z.string(),
  name: z.string(),
  filePath: z.string(),
  line: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
  isExported: z.boolean(),
  typeInfo: TypeInfoSchema,
});

const ModuleNodeSchema = z.object({
  kind: z.literal('module'),
  id: z.string(),
  name: z.string(),
  filePath: z.string(),
  exports: z.array(z.string()),
});

const GraphNodeSchema = z.discriminatedUnion('kind', [
  FunctionNodeSchema,
  ClassNodeSchema,
  InterfaceNodeSchema,
  TypeAliasNodeSchema,
  ModuleNodeSchema,
]);

// ---------------------------------------------------------------------------
// Edge Schemas
// ---------------------------------------------------------------------------

const CallEdgeSchema = z.object({
  kind: z.literal('call'),
  from: z.string(),
  to: z.string(),
  line: z.number().int().nonnegative(),
});

const ImportEdgeSchema = z.object({
  kind: z.literal('import'),
  from: z.string(),
  to: z.string(),
  importedNames: z.array(z.string()),
  isTypeOnly: z.boolean(),
});

const InheritsEdgeSchema = z.object({
  kind: z.literal('inherits'),
  from: z.string(),
  to: z.string(),
});

const ReferencesEdgeSchema = z.object({
  kind: z.literal('references'),
  from: z.string(),
  to: z.string(),
});

const GraphEdgeSchema = z.discriminatedUnion('kind', [
  CallEdgeSchema,
  ImportEdgeSchema,
  InheritsEdgeSchema,
  ReferencesEdgeSchema,
]);

// ---------------------------------------------------------------------------
// Top-level serialized graph schema
// In JSON, `nodes` is a plain Record (not a Map).
// ---------------------------------------------------------------------------

const SerializedDependencyGraphSchema = z.object({
  version: z.string(),
  generatedAt: z.string(),
  projectRoot: z.string(),
  entrypoints: z.array(z.string()),
  nodes: z.record(z.string(), GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Convert a validated parse result into a DependencyGraph (reconstructs Map). */
function buildDependencyGraph(
  data: z.infer<typeof SerializedDependencyGraphSchema>,
): DependencyGraph {
  // Type assertions are intentional: Zod has already validated the shape;
  // the only mismatch is exactOptionalPropertyTypes (z.optional() ⇒ T | undefined
  // vs. absent key). The runtime data is correct.
  const nodesMap = new Map(Object.entries(data.nodes)) as unknown as Map<string, GraphNode>;

  return {
    version: data.version,
    generatedAt: data.generatedAt,
    projectRoot: data.projectRoot,
    entrypoints: data.entrypoints as readonly string[],
    nodes: nodesMap as ReadonlyMap<string, GraphNode>,
    edges: data.edges as unknown as readonly GraphEdge[],
  };
}

/** Convert a DependencyGraph into the plain-object form suitable for JSON. */
function flattenGraph(graph: DependencyGraph): Record<string, unknown> {
  const nodesRecord: Record<string, GraphNode> = {};
  graph.nodes.forEach((node, id) => {
    nodesRecord[id] = node;
  });

  return {
    version: graph.version,
    generatedAt: graph.generatedAt,
    projectRoot: graph.projectRoot,
    entrypoints: graph.entrypoints,
    nodes: nodesRecord,
    edges: graph.edges,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Serializes a `DependencyGraph` to a JSON string.
 * The `ReadonlyMap<string, GraphNode>` is flattened to a plain
 * `Record<string, GraphNode>` for JSON compatibility.
 */
export function serializeGraph(graph: DependencyGraph): Result<string, SerializerError> {
  try {
    const json = JSON.stringify(flattenGraph(graph), null, 2);
    return ok(json);
  } catch (cause) {
    return err(
      makeSerializerError(
        'SERIALIZE_ERROR',
        'Failed to serialize dependency graph to JSON.',
        cause,
      ),
    );
  }
}

/**
 * Parses and validates a JSON string, reconstructing a `DependencyGraph`
 * with its `nodes` field as a `ReadonlyMap<string, GraphNode>`.
 */
export function deserializeGraph(json: string): Result<DependencyGraph, SerializerError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (cause) {
    return err(makeSerializerError('SERIALIZE_ERROR', 'Input string is not valid JSON.', cause));
  }

  const result = SerializedDependencyGraphSchema.safeParse(parsed);
  if (!result.success) {
    return err(
      makeSerializerError(
        'VALIDATION_FAILED',
        `Graph schema validation failed: ${result.error.message}`,
        result.error,
      ),
    );
  }

  return ok(buildDependencyGraph(result.data));
}

/**
 * Serializes a `DependencyGraph` and writes it to `filePath` as JSON.
 * Parent directories are created automatically.
 */
export function writeGraph(
  filePath: string,
  graph: DependencyGraph,
): Result<void, SerializerError> {
  const writeResult = writeJsonFile(filePath, flattenGraph(graph));
  if (writeResult.isErr()) {
    return err(
      makeSerializerError(
        'IO_ERROR',
        `Failed to write graph to "${filePath}": ${writeResult.error.message}`,
        writeResult.error,
      ),
    );
  }
  return ok(undefined);
}

/**
 * Reads and validates a serialized `DependencyGraph` from `filePath`.
 * Reconstructs the `nodes` field as a `ReadonlyMap<string, GraphNode>`.
 */
export function readGraph(filePath: string): Result<DependencyGraph, SerializerError> {
  const readResult = readJsonFile(filePath);
  if (readResult.isErr()) {
    return err(
      makeSerializerError(
        'IO_ERROR',
        `Failed to read graph from "${filePath}": ${readResult.error.message}`,
        readResult.error,
      ),
    );
  }

  const parseResult = SerializedDependencyGraphSchema.safeParse(readResult.value);
  if (!parseResult.success) {
    return err(
      makeSerializerError(
        'VALIDATION_FAILED',
        `Graph schema validation failed for "${filePath}": ${parseResult.error.message}`,
        parseResult.error,
      ),
    );
  }

  return ok(buildDependencyGraph(parseResult.data));
}

// ---------------------------------------------------------------------------
// Schema exports (useful for consumers validating sub-shapes)
// ---------------------------------------------------------------------------

export {
  TypeInfoSchema,
  ParameterInfoSchema,
  PropertyInfoSchema,
  GraphNodeSchema,
  GraphEdgeSchema,
  FunctionNodeSchema,
  ClassNodeSchema,
  InterfaceNodeSchema,
  TypeAliasNodeSchema,
  ModuleNodeSchema,
  CallEdgeSchema,
  ImportEdgeSchema,
  InheritsEdgeSchema,
  ReferencesEdgeSchema,
  SerializedDependencyGraphSchema,
};
