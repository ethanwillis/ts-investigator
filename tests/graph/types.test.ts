import {
  GRAPH_SCHEMA_VERSION,
  type TypeInfo,
  type ParameterInfo,
  type PropertyInfo,
  type FunctionNode,
  type ClassNode,
  type InterfaceNode,
  type TypeAliasNode,
  type ModuleNode,
  type GraphNode,
  type CallEdge,
  type ImportEdge,
  type InheritsEdge,
  type ReferencesEdge,
  type GraphEdge,
  type DependencyGraph,
} from '../../src/graph/types.js';

// ---------------------------------------------------------------------------
// GRAPH_SCHEMA_VERSION
// ---------------------------------------------------------------------------

describe('GRAPH_SCHEMA_VERSION', () => {
  it('is exported as the string "1.0"', () => {
    expect(GRAPH_SCHEMA_VERSION).toBe('1.0');
  });

  it('is a const (readonly) string literal', () => {
    // The type is '1.0' (not widened to string).
    // We verify at runtime that the value is exactly '1.0'.
    const version: '1.0' = GRAPH_SCHEMA_VERSION;
    expect(version).toBe('1.0');
  });
});

// ---------------------------------------------------------------------------
// TypeInfo — structural satisfies checks via runtime objects
// ---------------------------------------------------------------------------

describe('TypeInfo variants', () => {
  it('primitive variant is well-formed', () => {
    const t: TypeInfo = { kind: 'primitive', name: 'string' };
    expect(t.kind).toBe('primitive');
    if (t.kind === 'primitive') {
      expect(t.name).toBe('string');
    }
  });

  it('literal variant accepts string value', () => {
    const t: TypeInfo = { kind: 'literal', value: 'admin' };
    expect(t.kind).toBe('literal');
    if (t.kind === 'literal') {
      expect(t.value).toBe('admin');
    }
  });

  it('literal variant accepts number value', () => {
    const t: TypeInfo = { kind: 'literal', value: 42 };
    expect(t.kind).toBe('literal');
    if (t.kind === 'literal') {
      expect(t.value).toBe(42);
    }
  });

  it('literal variant accepts boolean value', () => {
    const t: TypeInfo = { kind: 'literal', value: true };
    expect(t.kind).toBe('literal');
    if (t.kind === 'literal') {
      expect(t.value).toBe(true);
    }
  });

  it('array variant is well-formed', () => {
    const t: TypeInfo = {
      kind: 'array',
      elementType: { kind: 'primitive', name: 'number' },
    };
    expect(t.kind).toBe('array');
    if (t.kind === 'array') {
      expect(t.elementType.kind).toBe('primitive');
    }
  });

  it('tuple variant is well-formed', () => {
    const t: TypeInfo = {
      kind: 'tuple',
      elements: [
        { kind: 'primitive', name: 'string' },
        { kind: 'primitive', name: 'number' },
      ],
    };
    expect(t.kind).toBe('tuple');
    if (t.kind === 'tuple') {
      expect(t.elements).toHaveLength(2);
    }
  });

  it('union variant is well-formed', () => {
    const t: TypeInfo = {
      kind: 'union',
      members: [
        { kind: 'primitive', name: 'string' },
        { kind: 'primitive', name: 'null' },
      ],
    };
    expect(t.kind).toBe('union');
    if (t.kind === 'union') {
      expect(t.members).toHaveLength(2);
    }
  });

  it('intersection variant is well-formed', () => {
    const t: TypeInfo = {
      kind: 'intersection',
      members: [
        { kind: 'object', properties: [] },
        { kind: 'object', properties: [] },
      ],
    };
    expect(t.kind).toBe('intersection');
    if (t.kind === 'intersection') {
      expect(t.members).toHaveLength(2);
    }
  });

  it('object variant is well-formed', () => {
    const prop: PropertyInfo = {
      name: 'id',
      typeInfo: { kind: 'primitive', name: 'number' },
      isOptional: false,
      isReadonly: false,
    };
    const t: TypeInfo = { kind: 'object', properties: [prop] };
    expect(t.kind).toBe('object');
    if (t.kind === 'object') {
      expect(t.properties).toHaveLength(1);
      expect(t.properties[0]?.name).toBe('id');
    }
  });

  it('reference variant is well-formed', () => {
    const t: TypeInfo = {
      kind: 'reference',
      name: 'Map',
      typeArguments: [
        { kind: 'primitive', name: 'string' },
        { kind: 'primitive', name: 'number' },
      ],
    };
    expect(t.kind).toBe('reference');
    if (t.kind === 'reference') {
      expect(t.name).toBe('Map');
      expect(t.typeArguments).toHaveLength(2);
    }
  });

  it('function variant is well-formed', () => {
    const param: ParameterInfo = {
      name: 'x',
      typeInfo: { kind: 'primitive', name: 'number' },
      isOptional: false,
      isRest: false,
    };
    const t: TypeInfo = {
      kind: 'function',
      parameters: [param],
      returnType: { kind: 'primitive', name: 'void' },
    };
    expect(t.kind).toBe('function');
    if (t.kind === 'function') {
      expect(t.parameters).toHaveLength(1);
      expect(t.returnType.kind).toBe('primitive');
    }
  });

  it('unknown variant is well-formed', () => {
    const t: TypeInfo = { kind: 'unknown', raw: 'ComplexType<X>' };
    expect(t.kind).toBe('unknown');
    if (t.kind === 'unknown') {
      expect(t.raw).toBe('ComplexType<X>');
    }
  });
});

// ---------------------------------------------------------------------------
// ParameterInfo
// ---------------------------------------------------------------------------

describe('ParameterInfo', () => {
  it('required parameter is well-formed', () => {
    const p: ParameterInfo = {
      name: 'name',
      typeInfo: { kind: 'primitive', name: 'string' },
      isOptional: false,
      isRest: false,
    };
    expect(p.name).toBe('name');
    expect(p.isOptional).toBe(false);
    expect(p.isRest).toBe(false);
  });

  it('optional parameter is well-formed', () => {
    const p: ParameterInfo = {
      name: 'email',
      typeInfo: { kind: 'primitive', name: 'string' },
      isOptional: true,
      isRest: false,
    };
    expect(p.isOptional).toBe(true);
  });

  it('rest parameter is well-formed', () => {
    const p: ParameterInfo = {
      name: 'items',
      typeInfo: { kind: 'array', elementType: { kind: 'primitive', name: 'string' } },
      isOptional: false,
      isRest: true,
    };
    expect(p.isRest).toBe(true);
  });

  it('parameter with default value is well-formed', () => {
    const p: ParameterInfo = {
      name: 'count',
      typeInfo: { kind: 'primitive', name: 'number' },
      isOptional: true,
      isRest: false,
      defaultValue: '10',
    };
    expect(p.defaultValue).toBe('10');
  });
});

// ---------------------------------------------------------------------------
// PropertyInfo
// ---------------------------------------------------------------------------

describe('PropertyInfo', () => {
  it('required non-readonly property is well-formed', () => {
    const prop: PropertyInfo = {
      name: 'id',
      typeInfo: { kind: 'primitive', name: 'number' },
      isOptional: false,
      isReadonly: false,
    };
    expect(prop.name).toBe('id');
    expect(prop.isOptional).toBe(false);
    expect(prop.isReadonly).toBe(false);
  });

  it('optional readonly property with jsdoc is well-formed', () => {
    const prop: PropertyInfo = {
      name: 'label',
      typeInfo: { kind: 'primitive', name: 'string' },
      isOptional: true,
      isReadonly: true,
      jsdoc: 'The display label.',
    };
    expect(prop.isOptional).toBe(true);
    expect(prop.isReadonly).toBe(true);
    expect(prop.jsdoc).toBe('The display label.');
  });
});

// ---------------------------------------------------------------------------
// Graph node shapes
// ---------------------------------------------------------------------------

describe('FunctionNode', () => {
  it('is well-formed', () => {
    const node: FunctionNode = {
      kind: 'function',
      id: 'src/utils.ts#function:greet',
      name: 'greet',
      filePath: '/project/src/utils.ts',
      line: 1,
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
    };

    expect(node.kind).toBe('function');
    expect(node.name).toBe('greet');
    expect(node.isAsync).toBe(false);
    expect(node.isExported).toBe(true);
    expect(node.parameters).toHaveLength(1);

    // satisfies check — node is assignable to GraphNode
    const graphNode: GraphNode = node;
    expect(graphNode.kind).toBe('function');
  });
});

describe('ClassNode', () => {
  it('is well-formed', () => {
    const node: ClassNode = {
      kind: 'class',
      id: 'src/index.ts#class:App',
      name: 'App',
      filePath: '/project/src/index.ts',
      line: 4,
      column: 0,
      isExported: true,
      interfaces: [],
      methods: [],
      properties: [],
    };

    expect(node.kind).toBe('class');
    expect(node.name).toBe('App');

    const graphNode: GraphNode = node;
    expect(graphNode.kind).toBe('class');
  });

  it('supports superClass and interface lists', () => {
    const node: ClassNode = {
      kind: 'class',
      id: 'src/foo.ts#class:Foo',
      name: 'Foo',
      filePath: '/project/src/foo.ts',
      line: 1,
      column: 0,
      isExported: false,
      superClass: 'Base',
      interfaces: ['Serializable', 'Comparable'],
      methods: [],
      properties: [],
    };

    expect(node.superClass).toBe('Base');
    expect(node.interfaces).toEqual(['Serializable', 'Comparable']);
  });
});

describe('InterfaceNode', () => {
  it('is well-formed', () => {
    const node: InterfaceNode = {
      kind: 'interface',
      id: 'src/types.ts#interface:User',
      name: 'User',
      filePath: '/project/src/types.ts',
      line: 1,
      column: 0,
      isExported: true,
      extends: [],
      properties: [],
    };

    expect(node.kind).toBe('interface');
    const graphNode: GraphNode = node;
    expect(graphNode.kind).toBe('interface');
  });
});

describe('TypeAliasNode', () => {
  it('is well-formed', () => {
    const node: TypeAliasNode = {
      kind: 'typeAlias',
      id: 'src/types.ts#typeAlias:Role',
      name: 'Role',
      filePath: '/project/src/types.ts',
      line: 10,
      column: 0,
      isExported: true,
      typeInfo: {
        kind: 'union',
        members: [
          { kind: 'literal', value: 'admin' },
          { kind: 'literal', value: 'user' },
          { kind: 'literal', value: 'guest' },
        ],
      },
    };

    expect(node.kind).toBe('typeAlias');
    const graphNode: GraphNode = node;
    expect(graphNode.kind).toBe('typeAlias');
  });
});

describe('ModuleNode', () => {
  it('is well-formed', () => {
    const node: ModuleNode = {
      kind: 'module',
      id: 'src/utils.ts#module',
      name: 'src/utils.ts',
      filePath: '/project/src/utils.ts',
      exports: ['greet', 'add', 'createUser'],
    };

    expect(node.kind).toBe('module');
    expect(node.exports).toContain('greet');

    const graphNode: GraphNode = node;
    expect(graphNode.kind).toBe('module');
  });
});

// ---------------------------------------------------------------------------
// Graph edge shapes
// ---------------------------------------------------------------------------

describe('CallEdge', () => {
  it('is well-formed', () => {
    const edge: CallEdge = {
      kind: 'call',
      from: 'src/index.ts#function:run',
      to: 'src/utils.ts#function:greet',
      line: 12,
    };

    expect(edge.kind).toBe('call');
    expect(edge.from).toContain('run');
    expect(edge.to).toContain('greet');

    const graphEdge: GraphEdge = edge;
    expect(graphEdge.kind).toBe('call');
  });
});

describe('ImportEdge', () => {
  it('is well-formed', () => {
    const edge: ImportEdge = {
      kind: 'import',
      from: 'src/index.ts#module',
      to: 'src/utils.ts#module',
      importedNames: ['greet', 'add'],
      isTypeOnly: false,
    };

    expect(edge.kind).toBe('import');
    expect(edge.importedNames).toContain('greet');
    expect(edge.isTypeOnly).toBe(false);

    const graphEdge: GraphEdge = edge;
    expect(graphEdge.kind).toBe('import');
  });

  it('supports type-only imports', () => {
    const edge: ImportEdge = {
      kind: 'import',
      from: 'src/index.ts#module',
      to: 'src/types.ts#module',
      importedNames: ['Config'],
      isTypeOnly: true,
    };
    expect(edge.isTypeOnly).toBe(true);
  });
});

describe('InheritsEdge', () => {
  it('is well-formed', () => {
    const edge: InheritsEdge = {
      kind: 'inherits',
      from: 'src/foo.ts#class:Derived',
      to: 'src/foo.ts#class:Base',
    };

    expect(edge.kind).toBe('inherits');

    const graphEdge: GraphEdge = edge;
    expect(graphEdge.kind).toBe('inherits');
  });
});

describe('ReferencesEdge', () => {
  it('is well-formed', () => {
    const edge: ReferencesEdge = {
      kind: 'references',
      from: 'src/utils.ts#function:createUser',
      to: 'src/types.ts#interface:User',
    };

    expect(edge.kind).toBe('references');

    const graphEdge: GraphEdge = edge;
    expect(graphEdge.kind).toBe('references');
  });
});

// ---------------------------------------------------------------------------
// DependencyGraph
// ---------------------------------------------------------------------------

describe('DependencyGraph', () => {
  it('is well-formed with empty nodes and edges', () => {
    const graph: DependencyGraph = {
      version: GRAPH_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      projectRoot: '/project',
      entrypoints: ['/project/src/index.ts'],
      nodes: new Map(),
      edges: [],
    };

    expect(graph.version).toBe('1.0');
    expect(graph.nodes.size).toBe(0);
    expect(graph.edges).toHaveLength(0);
  });

  it('can hold nodes and edges', () => {
    const functionNode: FunctionNode = {
      kind: 'function',
      id: 'src/utils.ts#function:greet',
      name: 'greet',
      filePath: '/project/src/utils.ts',
      line: 1,
      column: 0,
      isAsync: false,
      isExported: true,
      parameters: [],
      returnType: { kind: 'primitive', name: 'string' },
    };

    const moduleNode: ModuleNode = {
      kind: 'module',
      id: 'src/index.ts#module',
      name: 'src/index.ts',
      filePath: '/project/src/index.ts',
      exports: ['greet'],
    };

    const importEdge: ImportEdge = {
      kind: 'import',
      from: 'src/index.ts#module',
      to: 'src/utils.ts#module',
      importedNames: ['greet'],
      isTypeOnly: false,
    };

    const nodes = new Map<string, GraphNode>([
      [functionNode.id, functionNode],
      [moduleNode.id, moduleNode],
    ]);

    const graph: DependencyGraph = {
      version: GRAPH_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      projectRoot: '/project',
      entrypoints: ['/project/src/index.ts'],
      nodes,
      edges: [importEdge],
    };

    expect(graph.nodes.size).toBe(2);
    expect(graph.nodes.get('src/utils.ts#function:greet')).toEqual(functionNode);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.kind).toBe('import');
  });
});
