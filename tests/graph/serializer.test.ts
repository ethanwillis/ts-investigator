import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
  serializeGraph,
  deserializeGraph,
  writeGraph,
  readGraph,
} from '../../src/graph/serializer.js';
import {
  GRAPH_SCHEMA_VERSION,
  type DependencyGraph,
  type GraphNode,
  type FunctionNode,
  type ClassNode,
  type InterfaceNode,
  type TypeAliasNode,
  type ModuleNode,
  type CallEdge,
  type ImportEdge,
  type InheritsEdge,
  type ReferencesEdge,
  type TypeInfo,
  type ParameterInfo,
  type PropertyInfo,
} from '../../src/graph/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ts-investigator-test-'));
}

function makeMinimalGraph(overrides: Partial<DependencyGraph> = {}): DependencyGraph {
  return {
    version: GRAPH_SCHEMA_VERSION,
    generatedAt: '2024-01-01T00:00:00.000Z',
    projectRoot: '/project',
    entrypoints: ['/project/src/index.ts'],
    nodes: new Map() as ReadonlyMap<string, GraphNode>,
    edges: [],
    ...overrides,
  };
}

function makeModuleNode(overrides: Partial<ModuleNode> = {}): ModuleNode {
  return {
    kind: 'module',
    id: 'src/index.ts#module',
    name: 'src/index.ts',
    filePath: '/project/src/index.ts',
    exports: [],
    ...overrides,
  };
}

function makeFunctionNode(overrides: Partial<FunctionNode> = {}): FunctionNode {
  return {
    kind: 'function',
    id: 'src/utils.ts#function:greet',
    name: 'greet',
    filePath: '/project/src/utils.ts',
    line: 3,
    column: 0,
    isAsync: false,
    isExported: true,
    parameters: [
      {
        name: 'name',
        typeInfo: { kind: 'primitive', name: 'string' },
        isOptional: false,
        isRest: false,
      },
    ],
    returnType: { kind: 'primitive', name: 'string' },
    ...overrides,
  };
}

function makeClassNode(overrides: Partial<ClassNode> = {}): ClassNode {
  return {
    kind: 'class',
    id: 'src/index.ts#class:App',
    name: 'App',
    filePath: '/project/src/index.ts',
    line: 5,
    column: 0,
    isExported: true,
    interfaces: [],
    methods: [],
    properties: [],
    ...overrides,
  };
}

function makeInterfaceNode(overrides: Partial<InterfaceNode> = {}): InterfaceNode {
  return {
    kind: 'interface',
    id: 'src/types.ts#interface:User',
    name: 'User',
    filePath: '/project/src/types.ts',
    line: 1,
    column: 0,
    isExported: true,
    extends: [],
    properties: [],
    ...overrides,
  };
}

function makeTypeAliasNode(overrides: Partial<TypeAliasNode> = {}): TypeAliasNode {
  return {
    kind: 'typeAlias',
    id: 'src/types.ts#typeAlias:Role',
    name: 'Role',
    filePath: '/project/src/types.ts',
    line: 10,
    column: 0,
    isExported: true,
    typeInfo: { kind: 'primitive', name: 'string' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// serializeGraph
// ---------------------------------------------------------------------------

describe('serializeGraph', () => {
  it('returns ok with valid JSON string for a minimal graph', () => {
    const graph = makeMinimalGraph();
    const result = serializeGraph(graph);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const json = result.value;
      expect(typeof json).toBe('string');
      expect(() => JSON.parse(json)).not.toThrow();
    }
  });

  it('serialized JSON contains expected top-level fields', () => {
    const graph = makeMinimalGraph();
    const result = serializeGraph(graph);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = JSON.parse(result.value) as Record<string, unknown>;
      expect(parsed['version']).toBe(GRAPH_SCHEMA_VERSION);
      expect(parsed['generatedAt']).toBe('2024-01-01T00:00:00.000Z');
      expect(parsed['projectRoot']).toBe('/project');
      expect(Array.isArray(parsed['entrypoints'])).toBe(true);
      expect(typeof parsed['nodes']).toBe('object');
      expect(Array.isArray(parsed['edges'])).toBe(true);
    }
  });

  it('serializes ReadonlyMap nodes as a plain JSON object (record)', () => {
    const funcNode = makeFunctionNode();
    const nodes = new Map<string, GraphNode>([[funcNode.id, funcNode]]);
    const graph = makeMinimalGraph({ nodes: nodes as ReadonlyMap<string, GraphNode> });

    const result = serializeGraph(graph);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = JSON.parse(result.value) as { nodes: Record<string, unknown> };
      // nodes should be a plain object, not an array
      expect(Array.isArray(parsed.nodes)).toBe(false);
      expect(typeof parsed.nodes).toBe('object');
      expect(Object.keys(parsed.nodes)).toContain(funcNode.id);
    }
  });

  it('produces pretty-printed JSON (indented)', () => {
    const graph = makeMinimalGraph();
    const result = serializeGraph(graph);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // Pretty-printed JSON has newlines and spaces
      expect(result.value).toContain('\n');
      expect(result.value).toContain('  ');
    }
  });
});

// ---------------------------------------------------------------------------
// deserializeGraph
// ---------------------------------------------------------------------------

describe('deserializeGraph', () => {
  it('returns VALIDATION_FAILED for non-JSON input', () => {
    const result = deserializeGraph('not json at all {{{');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      // JSON.parse will throw SERIALIZE_ERROR for malformed JSON
      expect(['SERIALIZE_ERROR', 'VALIDATION_FAILED']).toContain(result.error.code);
      expect(result.error.kind).toBe('SerializerError');
    }
  });

  it('returns VALIDATION_FAILED for valid JSON that fails schema', () => {
    const badJson = JSON.stringify({ foo: 'bar' });
    const result = deserializeGraph(badJson);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('returns VALIDATION_FAILED for graph missing required fields', () => {
    const partial = JSON.stringify({
      version: '1.0',
      // missing generatedAt, projectRoot, entrypoints, nodes, edges
    });
    const result = deserializeGraph(partial);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('reconstructs nodes as a ReadonlyMap (has Map methods)', () => {
    const graph = makeMinimalGraph();
    const serialized = serializeGraph(graph);
    expect(serialized.isOk()).toBe(true);

    if (serialized.isOk()) {
      const result = deserializeGraph(serialized.value);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        const deserialized = result.value;
        // Should have Map-like interface
        expect(typeof deserialized.nodes.get).toBe('function');
        expect(typeof deserialized.nodes.has).toBe('function');
        expect(typeof deserialized.nodes.forEach).toBe('function');
        // size property
        expect(typeof deserialized.nodes.size).toBe('number');
      }
    }
  });

  it('deserializes a VALIDATION_FAILED error with useful message', () => {
    const result = deserializeGraph('{"wrong": true}');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Round-trip: serializeGraph → deserializeGraph
// ---------------------------------------------------------------------------

describe('serializeGraph / deserializeGraph round-trip', () => {
  it('round-trips a minimal empty graph', () => {
    const graph = makeMinimalGraph();
    const serialized = serializeGraph(graph);
    expect(serialized.isOk()).toBe(true);
    if (!serialized.isOk()) return;

    const result = deserializeGraph(serialized.value);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const rt = result.value;
    expect(rt.version).toBe(graph.version);
    expect(rt.generatedAt).toBe(graph.generatedAt);
    expect(rt.projectRoot).toBe(graph.projectRoot);
    expect(rt.entrypoints).toEqual([...graph.entrypoints]);
    expect(rt.nodes.size).toBe(0);
    expect(rt.edges).toHaveLength(0);
  });

  // ---- Node kind round-trips -----------------------------------------------

  it('round-trips a FunctionNode correctly', () => {
    const funcNode = makeFunctionNode();
    const nodes = new Map<string, GraphNode>([[funcNode.id, funcNode]]);
    const graph = makeMinimalGraph({ nodes: nodes as ReadonlyMap<string, GraphNode> });

    const rt = deserializeGraph(serializeGraph(graph)._unsafeUnwrap())._unsafeUnwrap();

    const rtNode = rt.nodes.get(funcNode.id);
    expect(rtNode).toBeDefined();
    expect(rtNode?.kind).toBe('function');
    if (rtNode?.kind === 'function') {
      expect(rtNode.name).toBe(funcNode.name);
      expect(rtNode.filePath).toBe(funcNode.filePath);
      expect(rtNode.line).toBe(funcNode.line);
      expect(rtNode.column).toBe(funcNode.column);
      expect(rtNode.isAsync).toBe(funcNode.isAsync);
      expect(rtNode.isExported).toBe(funcNode.isExported);
      expect(rtNode.parameters).toHaveLength(1);
      expect(rtNode.parameters[0]?.name).toBe('name');
      expect(rtNode.returnType.kind).toBe('primitive');
    }
  });

  it('round-trips a FunctionNode with optional jsdoc', () => {
    const funcNode = makeFunctionNode({ jsdoc: 'Greets a person.' });
    const nodes = new Map<string, GraphNode>([[funcNode.id, funcNode]]);
    const graph = makeMinimalGraph({ nodes: nodes as ReadonlyMap<string, GraphNode> });

    const rt = deserializeGraph(serializeGraph(graph)._unsafeUnwrap())._unsafeUnwrap();
    const rtNode = rt.nodes.get(funcNode.id);
    expect(rtNode?.kind === 'function' && rtNode.jsdoc).toBe('Greets a person.');
  });

  it('round-trips a ClassNode correctly', () => {
    const classNode = makeClassNode();
    const nodes = new Map<string, GraphNode>([[classNode.id, classNode]]);
    const graph = makeMinimalGraph({ nodes: nodes as ReadonlyMap<string, GraphNode> });

    const rt = deserializeGraph(serializeGraph(graph)._unsafeUnwrap())._unsafeUnwrap();
    const rtNode = rt.nodes.get(classNode.id);

    expect(rtNode).toBeDefined();
    expect(rtNode?.kind).toBe('class');
    if (rtNode?.kind === 'class') {
      expect(rtNode.name).toBe('App');
      expect(rtNode.isExported).toBe(true);
      expect(rtNode.interfaces).toEqual([]);
      expect(rtNode.methods).toEqual([]);
      expect(rtNode.properties).toEqual([]);
    }
  });

  it('round-trips a ClassNode with superClass and method', () => {
    const method = makeFunctionNode({
      id: 'src/index.ts#class:App#method:run',
      name: 'run',
    });
    const classNode = makeClassNode({ superClass: 'BaseApp', methods: [method] });
    const nodes = new Map<string, GraphNode>([[classNode.id, classNode]]);
    const graph = makeMinimalGraph({ nodes: nodes as ReadonlyMap<string, GraphNode> });

    const rt = deserializeGraph(serializeGraph(graph)._unsafeUnwrap())._unsafeUnwrap();
    const rtNode = rt.nodes.get(classNode.id);

    expect(rtNode?.kind === 'class' && rtNode.superClass).toBe('BaseApp');
    if (rtNode?.kind === 'class') {
      expect(rtNode.methods).toHaveLength(1);
      expect(rtNode.methods[0]?.name).toBe('run');
    }
  });

  it('round-trips an InterfaceNode correctly', () => {
    const prop: PropertyInfo = {
      name: 'id',
      typeInfo: { kind: 'primitive', name: 'number' },
      isOptional: false,
      isReadonly: false,
    };
    const ifaceNode = makeInterfaceNode({ properties: [prop], extends: ['Base'] });
    const nodes = new Map<string, GraphNode>([[ifaceNode.id, ifaceNode]]);
    const graph = makeMinimalGraph({ nodes: nodes as ReadonlyMap<string, GraphNode> });

    const rt = deserializeGraph(serializeGraph(graph)._unsafeUnwrap())._unsafeUnwrap();
    const rtNode = rt.nodes.get(ifaceNode.id);

    expect(rtNode?.kind).toBe('interface');
    if (rtNode?.kind === 'interface') {
      expect(rtNode.extends).toEqual(['Base']);
      expect(rtNode.properties).toHaveLength(1);
      expect(rtNode.properties[0]?.name).toBe('id');
    }
  });

  it('round-trips a TypeAliasNode correctly', () => {
    const typeAliasNode = makeTypeAliasNode({
      typeInfo: {
        kind: 'union',
        members: [
          { kind: 'literal', value: 'admin' },
          { kind: 'literal', value: 'user' },
          { kind: 'literal', value: 'guest' },
        ],
      },
    });
    const nodes = new Map<string, GraphNode>([[typeAliasNode.id, typeAliasNode]]);
    const graph = makeMinimalGraph({ nodes: nodes as ReadonlyMap<string, GraphNode> });

    const rt = deserializeGraph(serializeGraph(graph)._unsafeUnwrap())._unsafeUnwrap();
    const rtNode = rt.nodes.get(typeAliasNode.id);

    expect(rtNode?.kind).toBe('typeAlias');
    if (rtNode?.kind === 'typeAlias') {
      expect(rtNode.typeInfo.kind).toBe('union');
      if (rtNode.typeInfo.kind === 'union') {
        expect(rtNode.typeInfo.members).toHaveLength(3);
      }
    }
  });

  it('round-trips a ModuleNode correctly', () => {
    const moduleNode = makeModuleNode({ exports: ['greet', 'add', 'createUser'] });
    const nodes = new Map<string, GraphNode>([[moduleNode.id, moduleNode]]);
    const graph = makeMinimalGraph({ nodes: nodes as ReadonlyMap<string, GraphNode> });

    const rt = deserializeGraph(serializeGraph(graph)._unsafeUnwrap())._unsafeUnwrap();
    const rtNode = rt.nodes.get(moduleNode.id);

    expect(rtNode?.kind).toBe('module');
    if (rtNode?.kind === 'module') {
      expect(rtNode.exports).toEqual(['greet', 'add', 'createUser']);
    }
  });

  // ---- Edge kind round-trips -----------------------------------------------

  it('round-trips a CallEdge correctly', () => {
    const edge: CallEdge = {
      kind: 'call',
      from: 'src/index.ts#function:run',
      to: 'src/utils.ts#function:greet',
      line: 12,
    };
    const graph = makeMinimalGraph({ edges: [edge] });

    const rt = deserializeGraph(serializeGraph(graph)._unsafeUnwrap())._unsafeUnwrap();
    expect(rt.edges).toHaveLength(1);
    const rtEdge = rt.edges[0];
    expect(rtEdge?.kind).toBe('call');
    if (rtEdge?.kind === 'call') {
      expect(rtEdge.from).toBe(edge.from);
      expect(rtEdge.to).toBe(edge.to);
      expect(rtEdge.line).toBe(12);
    }
  });

  it('round-trips an ImportEdge correctly', () => {
    const edge: ImportEdge = {
      kind: 'import',
      from: 'src/index.ts#module',
      to: 'src/utils.ts#module',
      importedNames: ['greet', 'add'],
      isTypeOnly: false,
    };
    const graph = makeMinimalGraph({ edges: [edge] });

    const rt = deserializeGraph(serializeGraph(graph)._unsafeUnwrap())._unsafeUnwrap();
    const rtEdge = rt.edges[0];
    expect(rtEdge?.kind).toBe('import');
    if (rtEdge?.kind === 'import') {
      expect(rtEdge.importedNames).toEqual(['greet', 'add']);
      expect(rtEdge.isTypeOnly).toBe(false);
    }
  });

  it('round-trips a type-only ImportEdge correctly', () => {
    const edge: ImportEdge = {
      kind: 'import',
      from: 'src/index.ts#module',
      to: 'src/types.ts#module',
      importedNames: ['Config'],
      isTypeOnly: true,
    };
    const graph = makeMinimalGraph({ edges: [edge] });

    const rt = deserializeGraph(serializeGraph(graph)._unsafeUnwrap())._unsafeUnwrap();
    const rtEdge = rt.edges[0];
    expect(rtEdge?.kind === 'import' && rtEdge.isTypeOnly).toBe(true);
  });

  it('round-trips an InheritsEdge correctly', () => {
    const edge: InheritsEdge = {
      kind: 'inherits',
      from: 'src/foo.ts#class:Child',
      to: 'src/foo.ts#class:Parent',
    };
    const graph = makeMinimalGraph({ edges: [edge] });

    const rt = deserializeGraph(serializeGraph(graph)._unsafeUnwrap())._unsafeUnwrap();
    const rtEdge = rt.edges[0];
    expect(rtEdge?.kind).toBe('inherits');
    if (rtEdge?.kind === 'inherits') {
      expect(rtEdge.from).toBe(edge.from);
      expect(rtEdge.to).toBe(edge.to);
    }
  });

  it('round-trips a ReferencesEdge correctly', () => {
    const edge: ReferencesEdge = {
      kind: 'references',
      from: 'src/utils.ts#function:createUser',
      to: 'src/types.ts#interface:User',
    };
    const graph = makeMinimalGraph({ edges: [edge] });

    const rt = deserializeGraph(serializeGraph(graph)._unsafeUnwrap())._unsafeUnwrap();
    const rtEdge = rt.edges[0];
    expect(rtEdge?.kind).toBe('references');
    if (rtEdge?.kind === 'references') {
      expect(rtEdge.from).toBe(edge.from);
      expect(rtEdge.to).toBe(edge.to);
    }
  });

  // ---- TypeInfo variant round-trips ----------------------------------------

  const typeInfoCases: Array<{ label: string; typeInfo: TypeInfo }> = [
    { label: 'primitive string', typeInfo: { kind: 'primitive', name: 'string' } },
    { label: 'primitive number', typeInfo: { kind: 'primitive', name: 'number' } },
    { label: 'primitive boolean', typeInfo: { kind: 'primitive', name: 'boolean' } },
    { label: 'primitive null', typeInfo: { kind: 'primitive', name: 'null' } },
    { label: 'primitive undefined', typeInfo: { kind: 'primitive', name: 'undefined' } },
    { label: 'primitive void', typeInfo: { kind: 'primitive', name: 'void' } },
    { label: 'primitive never', typeInfo: { kind: 'primitive', name: 'never' } },
    { label: 'primitive unknown', typeInfo: { kind: 'primitive', name: 'unknown' } },
    { label: 'primitive any', typeInfo: { kind: 'primitive', name: 'any' } },
    { label: 'string literal', typeInfo: { kind: 'literal', value: 'hello' } },
    { label: 'number literal', typeInfo: { kind: 'literal', value: 42 } },
    { label: 'boolean literal', typeInfo: { kind: 'literal', value: true } },
    {
      label: 'array',
      typeInfo: { kind: 'array', elementType: { kind: 'primitive', name: 'string' } },
    },
    {
      label: 'tuple',
      typeInfo: {
        kind: 'tuple',
        elements: [
          { kind: 'primitive', name: 'string' },
          { kind: 'primitive', name: 'number' },
        ],
      },
    },
    {
      label: 'union',
      typeInfo: {
        kind: 'union',
        members: [
          { kind: 'primitive', name: 'string' },
          { kind: 'primitive', name: 'null' },
        ],
      },
    },
    {
      label: 'intersection',
      typeInfo: {
        kind: 'intersection',
        members: [
          { kind: 'object', properties: [] },
          { kind: 'object', properties: [] },
        ],
      },
    },
    {
      label: 'object with properties',
      typeInfo: {
        kind: 'object',
        properties: [
          {
            name: 'id',
            typeInfo: { kind: 'primitive', name: 'number' },
            isOptional: false,
            isReadonly: true,
          },
          {
            name: 'name',
            typeInfo: { kind: 'primitive', name: 'string' },
            isOptional: true,
            isReadonly: false,
          },
        ],
      },
    },
    {
      label: 'reference with typeArguments',
      typeInfo: {
        kind: 'reference',
        name: 'Map',
        typeArguments: [
          { kind: 'primitive', name: 'string' },
          { kind: 'primitive', name: 'number' },
        ],
      },
    },
    {
      label: 'function type',
      typeInfo: {
        kind: 'function',
        parameters: [
          {
            name: 'x',
            typeInfo: { kind: 'primitive', name: 'number' },
            isOptional: false,
            isRest: false,
          },
        ],
        returnType: { kind: 'primitive', name: 'boolean' },
      },
    },
    { label: 'unknown', typeInfo: { kind: 'unknown', raw: 'ComplexType<X>' } },
  ];

  typeInfoCases.forEach(({ label, typeInfo }) => {
    it(`round-trips TypeInfo variant: ${label}`, () => {
      const funcNode = makeFunctionNode({
        parameters: [
          {
            name: 'param',
            typeInfo,
            isOptional: false,
            isRest: false,
          },
        ],
        returnType: typeInfo,
      });
      const nodes = new Map<string, GraphNode>([[funcNode.id, funcNode]]);
      const graph = makeMinimalGraph({ nodes: nodes as ReadonlyMap<string, GraphNode> });

      const rt = deserializeGraph(serializeGraph(graph)._unsafeUnwrap())._unsafeUnwrap();
      const rtNode = rt.nodes.get(funcNode.id);

      expect(rtNode?.kind).toBe('function');
      if (rtNode?.kind === 'function') {
        const rtTypeInfo = rtNode.parameters[0]?.typeInfo;
        expect(rtTypeInfo?.kind).toBe(typeInfo.kind);
        // Spot-check that the top-level kind survives the round-trip
        expect(rtNode.returnType.kind).toBe(typeInfo.kind);
      }
    });
  });

  it('round-trips a ParameterInfo with defaultValue', () => {
    const param: ParameterInfo = {
      name: 'count',
      typeInfo: { kind: 'primitive', name: 'number' },
      isOptional: true,
      isRest: false,
      defaultValue: '10',
    };
    const funcNode = makeFunctionNode({ parameters: [param] });
    const nodes = new Map<string, GraphNode>([[funcNode.id, funcNode]]);
    const graph = makeMinimalGraph({ nodes: nodes as ReadonlyMap<string, GraphNode> });

    const rt = deserializeGraph(serializeGraph(graph)._unsafeUnwrap())._unsafeUnwrap();
    const rtNode = rt.nodes.get(funcNode.id);
    if (rtNode?.kind === 'function') {
      expect(rtNode.parameters[0]?.defaultValue).toBe('10');
      expect(rtNode.parameters[0]?.isOptional).toBe(true);
    }
  });

  it('round-trips a rest ParameterInfo', () => {
    const param: ParameterInfo = {
      name: 'items',
      typeInfo: { kind: 'array', elementType: { kind: 'primitive', name: 'string' } },
      isOptional: false,
      isRest: true,
    };
    const funcNode = makeFunctionNode({ parameters: [param] });
    const nodes = new Map<string, GraphNode>([[funcNode.id, funcNode]]);
    const graph = makeMinimalGraph({ nodes: nodes as ReadonlyMap<string, GraphNode> });

    const rt = deserializeGraph(serializeGraph(graph)._unsafeUnwrap())._unsafeUnwrap();
    const rtNode = rt.nodes.get(funcNode.id);
    if (rtNode?.kind === 'function') {
      expect(rtNode.parameters[0]?.isRest).toBe(true);
    }
  });

  it('round-trips a graph with multiple nodes and mixed edges', () => {
    const funcNode = makeFunctionNode();
    const moduleFrom = makeModuleNode({ id: 'src/index.ts#module', name: 'src/index.ts' });
    const moduleTo = makeModuleNode({
      id: 'src/utils.ts#module',
      name: 'src/utils.ts',
      filePath: '/project/src/utils.ts',
      exports: ['greet'],
    });

    const callEdge: CallEdge = {
      kind: 'call',
      from: 'src/index.ts#function:run',
      to: funcNode.id,
      line: 5,
    };
    const importEdge: ImportEdge = {
      kind: 'import',
      from: moduleFrom.id,
      to: moduleTo.id,
      importedNames: ['greet'],
      isTypeOnly: false,
    };

    const nodes = new Map<string, GraphNode>([
      [funcNode.id, funcNode],
      [moduleFrom.id, moduleFrom],
      [moduleTo.id, moduleTo],
    ]);
    const graph = makeMinimalGraph({
      nodes: nodes as ReadonlyMap<string, GraphNode>,
      edges: [callEdge, importEdge],
    });

    const rt = deserializeGraph(serializeGraph(graph)._unsafeUnwrap())._unsafeUnwrap();

    expect(rt.nodes.size).toBe(3);
    expect(rt.edges).toHaveLength(2);
    expect(rt.nodes.has(funcNode.id)).toBe(true);
    expect(rt.nodes.has(moduleFrom.id)).toBe(true);
    expect(rt.nodes.has(moduleTo.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// writeGraph / readGraph
// ---------------------------------------------------------------------------

describe('writeGraph', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a valid graph file to disk', () => {
    const graph = makeMinimalGraph();
    const filePath = path.join(tmpDir, 'graph.json');

    const result = writeGraph(filePath, graph);

    expect(result.isOk()).toBe(true);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('written file contains valid JSON', () => {
    const graph = makeMinimalGraph();
    const filePath = path.join(tmpDir, 'graph.json');

    writeGraph(filePath, graph);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it('creates parent directories automatically', () => {
    const graph = makeMinimalGraph();
    const filePath = path.join(tmpDir, 'nested', 'deep', 'graph.json');

    const result = writeGraph(filePath, graph);

    expect(result.isOk()).toBe(true);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('returns IO_ERROR when parent directory cannot be created (no permission)', () => {
    // Writing to a path under a file (not a dir) will cause mkdirSync to fail
    const conflictFile = path.join(tmpDir, 'notadir');
    fs.writeFileSync(conflictFile, 'data');
    const filePath = path.join(conflictFile, 'graph.json');

    const graph = makeMinimalGraph();
    const result = writeGraph(filePath, graph);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe('SerializerError');
      expect(result.error.code).toBe('IO_ERROR');
    }
  });
});

describe('readGraph', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns IO_ERROR when file does not exist', () => {
    const filePath = path.join(tmpDir, 'nonexistent.json');
    const result = readGraph(filePath);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe('SerializerError');
      expect(result.error.code).toBe('IO_ERROR');
    }
  });

  it('returns VALIDATION_FAILED for a file with invalid schema', () => {
    const filePath = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(filePath, JSON.stringify({ not: 'a graph' }), 'utf-8');

    const result = readGraph(filePath);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('returns IO_ERROR for a file with malformed JSON', () => {
    const filePath = path.join(tmpDir, 'malformed.json');
    fs.writeFileSync(filePath, '{bad json:::}', 'utf-8');

    const result = readGraph(filePath);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      // malformed JSON → PARSE_ERROR from readJsonFile → wrapped as IO_ERROR
      expect(result.error.kind).toBe('SerializerError');
      expect(['IO_ERROR', 'VALIDATION_FAILED']).toContain(result.error.code);
    }
  });

  it('reads back a graph written by writeGraph', () => {
    const funcNode = makeFunctionNode();
    const nodes = new Map<string, GraphNode>([[funcNode.id, funcNode]]);
    const graph = makeMinimalGraph({ nodes: nodes as ReadonlyMap<string, GraphNode> });
    const filePath = path.join(tmpDir, 'graph.json');

    const writeResult = writeGraph(filePath, graph);
    expect(writeResult.isOk()).toBe(true);

    const readResult = readGraph(filePath);
    expect(readResult.isOk()).toBe(true);

    if (readResult.isOk()) {
      const loaded = readResult.value;
      expect(loaded.version).toBe(graph.version);
      expect(loaded.projectRoot).toBe(graph.projectRoot);
      expect(loaded.nodes.size).toBe(1);
      expect(loaded.nodes.has(funcNode.id)).toBe(true);
    }
  });

  it('reconstructs nodes as a ReadonlyMap after readGraph', () => {
    const graph = makeMinimalGraph();
    const filePath = path.join(tmpDir, 'graph.json');

    writeGraph(filePath, graph);
    const result = readGraph(filePath);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(typeof result.value.nodes.get).toBe('function');
      expect(typeof result.value.nodes.has).toBe('function');
      expect(typeof result.value.nodes.size).toBe('number');
    }
  });

  it('writeGraph then readGraph preserves all node kinds', () => {
    const funcNode = makeFunctionNode();
    const classNode = makeClassNode();
    const ifaceNode = makeInterfaceNode();
    const typeAliasNode = makeTypeAliasNode();
    const moduleNode = makeModuleNode();

    const nodes = new Map<string, GraphNode>([
      [funcNode.id, funcNode],
      [classNode.id, classNode],
      [ifaceNode.id, ifaceNode],
      [typeAliasNode.id, typeAliasNode],
      [moduleNode.id, moduleNode],
    ]);
    const graph = makeMinimalGraph({ nodes: nodes as ReadonlyMap<string, GraphNode> });
    const filePath = path.join(tmpDir, 'graph.json');

    writeGraph(filePath, graph);
    const result = readGraph(filePath);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const loaded = result.value;
      expect(loaded.nodes.size).toBe(5);
      expect(loaded.nodes.get(funcNode.id)?.kind).toBe('function');
      expect(loaded.nodes.get(classNode.id)?.kind).toBe('class');
      expect(loaded.nodes.get(ifaceNode.id)?.kind).toBe('interface');
      expect(loaded.nodes.get(typeAliasNode.id)?.kind).toBe('typeAlias');
      expect(loaded.nodes.get(moduleNode.id)?.kind).toBe('module');
    }
  });

  it('writeGraph then readGraph preserves all edge kinds', () => {
    const callEdge: CallEdge = {
      kind: 'call',
      from: 'src/a.ts#function:foo',
      to: 'src/b.ts#function:bar',
      line: 7,
    };
    const importEdge: ImportEdge = {
      kind: 'import',
      from: 'src/a.ts#module',
      to: 'src/b.ts#module',
      importedNames: ['bar'],
      isTypeOnly: false,
    };
    const inheritsEdge: InheritsEdge = {
      kind: 'inherits',
      from: 'src/a.ts#class:Child',
      to: 'src/a.ts#class:Parent',
    };
    const referencesEdge: ReferencesEdge = {
      kind: 'references',
      from: 'src/a.ts#function:foo',
      to: 'src/types.ts#interface:Foo',
    };

    const graph = makeMinimalGraph({
      edges: [callEdge, importEdge, inheritsEdge, referencesEdge],
    });
    const filePath = path.join(tmpDir, 'graph.json');

    writeGraph(filePath, graph);
    const result = readGraph(filePath);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const edges = result.value.edges;
      expect(edges).toHaveLength(4);
      expect(edges.map((e) => e.kind).sort()).toEqual(
        ['call', 'import', 'inherits', 'references'].sort(),
      );
    }
  });
});
