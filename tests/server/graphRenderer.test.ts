import { buildDotString } from '../../src/server/graphRenderer.js';
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
} from '../../src/graph/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmptyGraph(overrides: Partial<DependencyGraph> = {}): DependencyGraph {
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

function makeGraphWithNodes(nodes: GraphNode[]): DependencyGraph {
  const nodeMap = new Map<string, GraphNode>(nodes.map((n) => [n.id, n]));
  return makeEmptyGraph({ nodes: nodeMap as ReadonlyMap<string, GraphNode> });
}

function makeGraphWithEdges(nodes: GraphNode[], edges: DependencyGraph['edges']): DependencyGraph {
  const nodeMap = new Map<string, GraphNode>(nodes.map((n) => [n.id, n]));
  return makeEmptyGraph({
    nodes: nodeMap as ReadonlyMap<string, GraphNode>,
    edges,
  });
}

// ---------------------------------------------------------------------------
// buildDotString — basic structure
// ---------------------------------------------------------------------------

describe('buildDotString', () => {
  describe('output structure', () => {
    it('returns a string', () => {
      const dot = buildDotString(makeEmptyGraph());
      expect(typeof dot).toBe('string');
    });

    it('starts with "digraph G {"', () => {
      const dot = buildDotString(makeEmptyGraph());
      expect(dot.startsWith('digraph G {')).toBe(true);
    });

    it('ends with "}"', () => {
      const dot = buildDotString(makeEmptyGraph());
      expect(dot.trimEnd().endsWith('}')).toBe(true);
    });

    it('contains rankdir=TB for top-to-bottom layout', () => {
      const dot = buildDotString(makeEmptyGraph());
      expect(dot).toContain('rankdir=TB');
    });

    it('contains a node style declaration', () => {
      const dot = buildDotString(makeEmptyGraph());
      expect(dot).toContain('node [');
    });

    it('contains an edge style declaration', () => {
      const dot = buildDotString(makeEmptyGraph());
      expect(dot).toContain('edge [');
    });

    it('produces valid DOT with no nodes and no edges (empty graph)', () => {
      const dot = buildDotString(makeEmptyGraph());
      // A minimal valid DOT graph must at least open and close
      expect(dot).toContain('digraph G {');
      expect(dot).toContain('}');
      // Must NOT contain "->" when there are no edges
      expect(dot).not.toContain('->');
    });
  });

  // --------------------------------------------------------------------------
  // FunctionNode in DOT output
  // --------------------------------------------------------------------------

  describe('FunctionNode in DOT output', () => {
    it('contains the node id quoted in the DOT output', () => {
      const node = makeFunctionNode();
      const dot = buildDotString(makeGraphWithNodes([node]));
      // DOT node ids are double-quoted
      expect(dot).toContain(`"${node.id}"`);
    });

    it('contains the function name in the label', () => {
      const node = makeFunctionNode({ name: 'greet' });
      const dot = buildDotString(makeGraphWithNodes([node]));
      expect(dot).toContain('greet');
    });

    it('contains the kind "function" in the label', () => {
      const node = makeFunctionNode();
      const dot = buildDotString(makeGraphWithNodes([node]));
      expect(dot).toContain('function');
    });

    it('contains the fillcolor for a function node', () => {
      const node = makeFunctionNode();
      const dot = buildDotString(makeGraphWithNodes([node]));
      // Function nodes use fillcolor="#4A90D9" (from NODE_COLORS)
      expect(dot).toContain('fillcolor="#4A90D9"');
    });

    it('contains style="filled,rounded" for the node', () => {
      const node = makeFunctionNode();
      const dot = buildDotString(makeGraphWithNodes([node]));
      expect(dot).toContain('style="filled,rounded"');
    });

    it('contains shape="box" for the node', () => {
      const node = makeFunctionNode();
      const dot = buildDotString(makeGraphWithNodes([node]));
      expect(dot).toContain('shape="box"');
    });

    it('node id attribute matches the node id', () => {
      const node = makeFunctionNode({ id: 'src/utils.ts#function:greet' });
      const dot = buildDotString(makeGraphWithNodes([node]));
      expect(dot).toContain('id="src/utils.ts#function:greet"');
    });
  });

  // --------------------------------------------------------------------------
  // ClassNode in DOT output
  // --------------------------------------------------------------------------

  describe('ClassNode in DOT output', () => {
    it('contains the class node id in the output', () => {
      const node = makeClassNode();
      const dot = buildDotString(makeGraphWithNodes([node]));
      expect(dot).toContain(`"${node.id}"`);
    });

    it('contains the class name in the label', () => {
      const node = makeClassNode({ name: 'App' });
      const dot = buildDotString(makeGraphWithNodes([node]));
      expect(dot).toContain('App');
    });

    it('contains "class" in the label', () => {
      const node = makeClassNode();
      const dot = buildDotString(makeGraphWithNodes([node]));
      expect(dot).toContain('class');
    });

    it('uses the class fillcolor "#E67E22"', () => {
      const node = makeClassNode();
      const dot = buildDotString(makeGraphWithNodes([node]));
      expect(dot).toContain('fillcolor="#E67E22"');
    });
  });

  // --------------------------------------------------------------------------
  // InterfaceNode in DOT output
  // --------------------------------------------------------------------------

  describe('InterfaceNode in DOT output', () => {
    it('contains the interface node id', () => {
      const node = makeInterfaceNode();
      const dot = buildDotString(makeGraphWithNodes([node]));
      expect(dot).toContain(`"${node.id}"`);
    });

    it('contains the interface name in the label', () => {
      const node = makeInterfaceNode({ name: 'User' });
      const dot = buildDotString(makeGraphWithNodes([node]));
      expect(dot).toContain('User');
    });

    it('uses the interface fillcolor "#27AE60"', () => {
      const node = makeInterfaceNode();
      const dot = buildDotString(makeGraphWithNodes([node]));
      expect(dot).toContain('fillcolor="#27AE60"');
    });
  });

  // --------------------------------------------------------------------------
  // TypeAliasNode in DOT output
  // --------------------------------------------------------------------------

  describe('TypeAliasNode in DOT output', () => {
    it('contains the typeAlias node id', () => {
      const node = makeTypeAliasNode();
      const dot = buildDotString(makeGraphWithNodes([node]));
      expect(dot).toContain(`"${node.id}"`);
    });

    it('contains the type alias name in the label', () => {
      const node = makeTypeAliasNode({ name: 'Role' });
      const dot = buildDotString(makeGraphWithNodes([node]));
      expect(dot).toContain('Role');
    });

    it('uses the typeAlias fillcolor "#8E44AD"', () => {
      const node = makeTypeAliasNode();
      const dot = buildDotString(makeGraphWithNodes([node]));
      expect(dot).toContain('fillcolor="#8E44AD"');
    });
  });

  // --------------------------------------------------------------------------
  // ModuleNode in DOT output
  // --------------------------------------------------------------------------

  describe('ModuleNode in DOT output', () => {
    it('contains the module node id', () => {
      const node = makeModuleNode();
      const dot = buildDotString(makeGraphWithNodes([node]));
      expect(dot).toContain(`"${node.id}"`);
    });

    it('contains the module name in the label', () => {
      const node = makeModuleNode({ name: 'src/index.ts' });
      const dot = buildDotString(makeGraphWithNodes([node]));
      expect(dot).toContain('src/index.ts');
    });

    it('uses the module fillcolor "#95A5A6"', () => {
      const node = makeModuleNode();
      const dot = buildDotString(makeGraphWithNodes([node]));
      expect(dot).toContain('fillcolor="#95A5A6"');
    });
  });

  // --------------------------------------------------------------------------
  // Multiple nodes
  // --------------------------------------------------------------------------

  describe('multiple nodes', () => {
    it('contains all node ids when multiple nodes are present', () => {
      const funcNode = makeFunctionNode();
      const classNode = makeClassNode();
      const moduleNode = makeModuleNode();

      const dot = buildDotString(makeGraphWithNodes([funcNode, classNode, moduleNode]));

      expect(dot).toContain(`"${funcNode.id}"`);
      expect(dot).toContain(`"${classNode.id}"`);
      expect(dot).toContain(`"${moduleNode.id}"`);
    });

    it('contains all node names when multiple nodes are present', () => {
      const funcNode = makeFunctionNode({ name: 'greet' });
      const classNode = makeClassNode({ name: 'App' });

      const dot = buildDotString(makeGraphWithNodes([funcNode, classNode]));

      expect(dot).toContain('greet');
      expect(dot).toContain('App');
    });

    it('contains multiple fillcolors for different node kinds', () => {
      const funcNode = makeFunctionNode();
      const classNode = makeClassNode();

      const dot = buildDotString(makeGraphWithNodes([funcNode, classNode]));

      // Each kind has its own color
      expect(dot).toContain('fillcolor="#4A90D9"'); // function
      expect(dot).toContain('fillcolor="#E67E22"'); // class
    });
  });

  // --------------------------------------------------------------------------
  // CallEdge in DOT output
  // --------------------------------------------------------------------------

  describe('CallEdge in DOT output', () => {
    it('contains "->" for a CallEdge', () => {
      const from = makeFunctionNode({ id: 'src/index.ts#function:run', name: 'run' });
      const to = makeFunctionNode({ id: 'src/utils.ts#function:greet', name: 'greet' });
      const edge: CallEdge = {
        kind: 'call',
        from: from.id,
        to: to.id,
        line: 12,
      };
      const dot = buildDotString(makeGraphWithEdges([from, to], [edge]));
      expect(dot).toContain('->');
    });

    it('edge references the correct from and to node ids', () => {
      const from = makeFunctionNode({ id: 'src/index.ts#function:run', name: 'run' });
      const to = makeFunctionNode({ id: 'src/utils.ts#function:greet', name: 'greet' });
      const edge: CallEdge = {
        kind: 'call',
        from: from.id,
        to: to.id,
        line: 12,
      };
      const dot = buildDotString(makeGraphWithEdges([from, to], [edge]));
      // Should contain something like: "from" -> "to"
      expect(dot).toContain(`"${from.id}" -> "${to.id}"`);
    });

    it('call edge uses style="solid"', () => {
      const from = makeFunctionNode({ id: 'src/index.ts#function:run', name: 'run' });
      const to = makeFunctionNode({ id: 'src/utils.ts#function:greet', name: 'greet' });
      const edge: CallEdge = { kind: 'call', from: from.id, to: to.id, line: 5 };
      const dot = buildDotString(makeGraphWithEdges([from, to], [edge]));
      expect(dot).toContain('style="solid"');
    });

    it('call edge uses call edge color "#4A90D9"', () => {
      const from = makeFunctionNode({ id: 'src/a.ts#function:foo', name: 'foo' });
      const to = makeFunctionNode({ id: 'src/b.ts#function:bar', name: 'bar' });
      const edge: CallEdge = { kind: 'call', from: from.id, to: to.id, line: 1 };
      const dot = buildDotString(makeGraphWithEdges([from, to], [edge]));
      // Call edges use color="#4A90D9"
      expect(dot).toContain('color="#4A90D9"');
    });
  });

  // --------------------------------------------------------------------------
  // ImportEdge in DOT output
  // --------------------------------------------------------------------------

  describe('ImportEdge in DOT output', () => {
    it('contains "->" for an ImportEdge', () => {
      const from = makeModuleNode({ id: 'src/index.ts#module', name: 'src/index.ts' });
      const to = makeModuleNode({
        id: 'src/utils.ts#module',
        name: 'src/utils.ts',
        filePath: '/project/src/utils.ts',
      });
      const edge: ImportEdge = {
        kind: 'import',
        from: from.id,
        to: to.id,
        importedNames: ['greet', 'add'],
        isTypeOnly: false,
      };
      const dot = buildDotString(makeGraphWithEdges([from, to], [edge]));
      expect(dot).toContain('->');
    });

    it('import edge uses style="dashed"', () => {
      const from = makeModuleNode({ id: 'src/index.ts#module', name: 'src/index.ts' });
      const to = makeModuleNode({
        id: 'src/utils.ts#module',
        name: 'src/utils.ts',
        filePath: '/project/src/utils.ts',
      });
      const edge: ImportEdge = {
        kind: 'import',
        from: from.id,
        to: to.id,
        importedNames: ['greet'],
        isTypeOnly: false,
      };
      const dot = buildDotString(makeGraphWithEdges([from, to], [edge]));
      expect(dot).toContain('style="dashed"');
    });

    it('import edge annotates with imported names (up to 3)', () => {
      const from = makeModuleNode({ id: 'src/a.ts#module', name: 'src/a.ts' });
      const to = makeModuleNode({
        id: 'src/b.ts#module',
        name: 'src/b.ts',
        filePath: '/project/src/b.ts',
      });
      const edge: ImportEdge = {
        kind: 'import',
        from: from.id,
        to: to.id,
        importedNames: ['foo', 'bar', 'baz'],
        isTypeOnly: false,
      };
      const dot = buildDotString(makeGraphWithEdges([from, to], [edge]));
      // The names should appear in the edge label attribute
      expect(dot).toContain('foo');
      expect(dot).toContain('bar');
      expect(dot).toContain('baz');
    });

    it('import edge with more than 3 imported names truncates with ellipsis', () => {
      const from = makeModuleNode({ id: 'src/a.ts#module', name: 'src/a.ts' });
      const to = makeModuleNode({
        id: 'src/b.ts#module',
        name: 'src/b.ts',
        filePath: '/project/src/b.ts',
      });
      const edge: ImportEdge = {
        kind: 'import',
        from: from.id,
        to: to.id,
        importedNames: ['a', 'b', 'c', 'd', 'e'],
        isTypeOnly: false,
      };
      const dot = buildDotString(makeGraphWithEdges([from, to], [edge]));
      // Should include the Unicode ellipsis character for overflow
      expect(dot).toContain('\u2026');
    });

    it('import edge with zero imported names has no label attribute', () => {
      const from = makeModuleNode({ id: 'src/a.ts#module', name: 'src/a.ts' });
      const to = makeModuleNode({
        id: 'src/b.ts#module',
        name: 'src/b.ts',
        filePath: '/project/src/b.ts',
      });
      const edge: ImportEdge = {
        kind: 'import',
        from: from.id,
        to: to.id,
        importedNames: [],
        isTypeOnly: false,
      };
      const dot = buildDotString(makeGraphWithEdges([from, to], [edge]));
      // When importedNames is empty, there should be no extra label= for the edge
      const edgeLineMatch = dot.match(/"src\/a\.ts#module" -> "src\/b\.ts#module"[^;]*/);
      expect(edgeLineMatch).not.toBeNull();
      if (edgeLineMatch) {
        expect(edgeLineMatch[0]).not.toContain(', label=');
      }
    });

    it('import edge uses import edge color "#5a5a8a"', () => {
      const from = makeModuleNode({ id: 'src/a.ts#module', name: 'src/a.ts' });
      const to = makeModuleNode({
        id: 'src/b.ts#module',
        name: 'src/b.ts',
        filePath: '/project/src/b.ts',
      });
      const edge: ImportEdge = {
        kind: 'import',
        from: from.id,
        to: to.id,
        importedNames: [],
        isTypeOnly: false,
      };
      const dot = buildDotString(makeGraphWithEdges([from, to], [edge]));
      expect(dot).toContain('color="#5a5a8a"');
    });
  });

  // --------------------------------------------------------------------------
  // InheritsEdge in DOT output
  // --------------------------------------------------------------------------

  describe('InheritsEdge in DOT output', () => {
    it('contains "->" for an InheritsEdge', () => {
      const child = makeClassNode({ id: 'src/foo.ts#class:Child', name: 'Child' });
      const parent = makeClassNode({ id: 'src/foo.ts#class:Parent', name: 'Parent' });
      const edge: InheritsEdge = {
        kind: 'inherits',
        from: child.id,
        to: parent.id,
      };
      const dot = buildDotString(makeGraphWithEdges([child, parent], [edge]));
      expect(dot).toContain('->');
    });

    it('inherits edge uses style="bold"', () => {
      const child = makeClassNode({ id: 'src/foo.ts#class:Child', name: 'Child' });
      const parent = makeClassNode({ id: 'src/foo.ts#class:Parent', name: 'Parent' });
      const edge: InheritsEdge = { kind: 'inherits', from: child.id, to: parent.id };
      const dot = buildDotString(makeGraphWithEdges([child, parent], [edge]));
      expect(dot).toContain('style="bold"');
    });

    it('inherits edge uses color "#27AE60"', () => {
      const child = makeClassNode({ id: 'src/foo.ts#class:Child', name: 'Child' });
      const parent = makeClassNode({ id: 'src/foo.ts#class:Parent', name: 'Parent' });
      const edge: InheritsEdge = { kind: 'inherits', from: child.id, to: parent.id };
      const dot = buildDotString(makeGraphWithEdges([child, parent], [edge]));
      expect(dot).toContain('color="#27AE60"');
    });

    it('edge references correct from and to ids', () => {
      const child = makeClassNode({ id: 'src/foo.ts#class:Child', name: 'Child' });
      const parent = makeClassNode({ id: 'src/foo.ts#class:Parent', name: 'Parent' });
      const edge: InheritsEdge = { kind: 'inherits', from: child.id, to: parent.id };
      const dot = buildDotString(makeGraphWithEdges([child, parent], [edge]));
      expect(dot).toContain(`"${child.id}" -> "${parent.id}"`);
    });
  });

  // --------------------------------------------------------------------------
  // ReferencesEdge in DOT output
  // --------------------------------------------------------------------------

  describe('ReferencesEdge in DOT output', () => {
    it('contains "->" for a ReferencesEdge', () => {
      const func = makeFunctionNode();
      const iface = makeInterfaceNode();
      const edge: ReferencesEdge = {
        kind: 'references',
        from: func.id,
        to: iface.id,
      };
      const dot = buildDotString(makeGraphWithEdges([func, iface], [edge]));
      expect(dot).toContain('->');
    });

    it('references edge uses style="dotted"', () => {
      const func = makeFunctionNode();
      const iface = makeInterfaceNode();
      const edge: ReferencesEdge = { kind: 'references', from: func.id, to: iface.id };
      const dot = buildDotString(makeGraphWithEdges([func, iface], [edge]));
      expect(dot).toContain('style="dotted"');
    });

    it('references edge uses color "#8E44AD"', () => {
      const func = makeFunctionNode();
      const iface = makeInterfaceNode();
      const edge: ReferencesEdge = { kind: 'references', from: func.id, to: iface.id };
      const dot = buildDotString(makeGraphWithEdges([func, iface], [edge]));
      expect(dot).toContain('color="#8E44AD"');
    });

    it('edge references correct from and to ids', () => {
      const func = makeFunctionNode();
      const iface = makeInterfaceNode();
      const edge: ReferencesEdge = { kind: 'references', from: func.id, to: iface.id };
      const dot = buildDotString(makeGraphWithEdges([func, iface], [edge]));
      expect(dot).toContain(`"${func.id}" -> "${iface.id}"`);
    });
  });

  // --------------------------------------------------------------------------
  // Edge style is applied correctly by kind
  // --------------------------------------------------------------------------

  describe('edge style by kind', () => {
    const edgeStyleCases: Array<{
      label: string;
      edge: DependencyGraph['edges'][number];
      expectedStyle: string;
    }> = [
      {
        label: 'call → solid',
        edge: {
          kind: 'call',
          from: 'src/a.ts#function:foo',
          to: 'src/b.ts#function:bar',
          line: 1,
        },
        expectedStyle: 'solid',
      },
      {
        label: 'import → dashed',
        edge: {
          kind: 'import',
          from: 'src/a.ts#module',
          to: 'src/b.ts#module',
          importedNames: [],
          isTypeOnly: false,
        },
        expectedStyle: 'dashed',
      },
      {
        label: 'inherits → bold',
        edge: {
          kind: 'inherits',
          from: 'src/a.ts#class:Child',
          to: 'src/a.ts#class:Parent',
        },
        expectedStyle: 'bold',
      },
      {
        label: 'references → dotted',
        edge: {
          kind: 'references',
          from: 'src/a.ts#function:foo',
          to: 'src/types.ts#interface:Foo',
        },
        expectedStyle: 'dotted',
      },
    ];

    edgeStyleCases.forEach(({ label, edge, expectedStyle }) => {
      it(`${label}`, () => {
        // Build a graph with a matching from-node and to-node stub
        const fromNode = makeModuleNode({ id: edge.from, name: edge.from });
        const toNode = makeModuleNode({ id: edge.to, name: edge.to });
        const dot = buildDotString(makeGraphWithEdges([fromNode, toNode], [edge]));
        expect(dot).toContain(`style="${expectedStyle}"`);
      });
    });
  });

  // --------------------------------------------------------------------------
  // DOT escaping
  // --------------------------------------------------------------------------

  describe('DOT string escaping', () => {
    it('escapes double quotes in node ids', () => {
      // A node id with a double-quote should be escaped as \"
      const node = makeFunctionNode({ id: 'src/utils.ts#function:say"hello"', name: 'say' });
      const dot = buildDotString(makeGraphWithNodes([node]));
      // Should not break DOT syntax with unescaped quotes
      expect(dot).toContain('\\"hello\\"');
    });

    it('escapes backslashes in node names', () => {
      const node = makeFunctionNode({ name: 'back\\slash' });
      const dot = buildDotString(makeGraphWithNodes([node]));
      // backslash must be escaped as \\
      expect(dot).toContain('back\\\\slash');
    });

    it('escapes newlines in node names as \\n (DOT centred newline)', () => {
      const node = makeFunctionNode({ name: 'line1\nline2' });
      const dot = buildDotString(makeGraphWithNodes([node]));
      expect(dot).toContain('line1\\nline2');
    });

    it('removes carriage returns from node names', () => {
      const node = makeFunctionNode({ name: 'win\r\nends' });
      const dot = buildDotString(makeGraphWithNodes([node]));
      // \r should be stripped; \n escaped
      expect(dot).not.toContain('\r');
    });

    it('node label contains kind and name separated by \\n (DOT newline)', () => {
      const node = makeFunctionNode({ name: 'myFunc' });
      const dot = buildDotString(makeGraphWithNodes([node]));
      // The label format is "kind\nname" (DOT centred newline = \\n in source)
      expect(dot).toContain('function\\nmyFunc');
    });
  });

  // --------------------------------------------------------------------------
  // Multiple edges
  // --------------------------------------------------------------------------

  describe('multiple edges', () => {
    it('produces "->" for each edge in the graph', () => {
      const a = makeModuleNode({ id: 'src/a.ts#module', name: 'src/a.ts' });
      const b = makeModuleNode({
        id: 'src/b.ts#module',
        name: 'src/b.ts',
        filePath: '/project/src/b.ts',
      });
      const c = makeModuleNode({
        id: 'src/c.ts#module',
        name: 'src/c.ts',
        filePath: '/project/src/c.ts',
      });

      const edges: DependencyGraph['edges'] = [
        {
          kind: 'import',
          from: a.id,
          to: b.id,
          importedNames: ['foo'],
          isTypeOnly: false,
        },
        {
          kind: 'import',
          from: b.id,
          to: c.id,
          importedNames: ['bar'],
          isTypeOnly: false,
        },
      ];

      const dot = buildDotString(makeGraphWithEdges([a, b, c], edges));

      // Both edges should produce arrows
      expect(dot).toContain(`"${a.id}" -> "${b.id}"`);
      expect(dot).toContain(`"${b.id}" -> "${c.id}"`);
    });

    it('all four edge kinds can coexist in one graph', () => {
      const modA = makeModuleNode({ id: 'src/a.ts#module', name: 'a' });
      const modB = makeModuleNode({
        id: 'src/b.ts#module',
        name: 'b',
        filePath: '/project/src/b.ts',
      });
      const funcA = makeFunctionNode({ id: 'src/a.ts#function:foo', name: 'foo' });
      const funcB = makeFunctionNode({ id: 'src/b.ts#function:bar', name: 'bar' });
      const classChild = makeClassNode({ id: 'src/a.ts#class:Child', name: 'Child' });
      const classParent = makeClassNode({ id: 'src/a.ts#class:Parent', name: 'Parent' });
      const iface = makeInterfaceNode({ id: 'src/types.ts#interface:I', name: 'I' });

      const edges: DependencyGraph['edges'] = [
        { kind: 'call', from: funcA.id, to: funcB.id, line: 10 },
        {
          kind: 'import',
          from: modA.id,
          to: modB.id,
          importedNames: ['bar'],
          isTypeOnly: false,
        },
        { kind: 'inherits', from: classChild.id, to: classParent.id },
        { kind: 'references', from: funcA.id, to: iface.id },
      ];

      const dot = buildDotString(
        makeGraphWithEdges([modA, modB, funcA, funcB, classChild, classParent, iface], edges),
      );

      // All styles should appear (deduplicated would still contain all four)
      expect(dot).toContain('style="solid"');
      expect(dot).toContain('style="dashed"');
      expect(dot).toContain('style="bold"');
      expect(dot).toContain('style="dotted"');
    });
  });

  // --------------------------------------------------------------------------
  // Graph-level DOT attributes
  // --------------------------------------------------------------------------

  describe('DOT graph-level attributes', () => {
    it('contains bgcolor attribute for dark background', () => {
      const dot = buildDotString(makeEmptyGraph());
      expect(dot).toContain('bgcolor=');
    });

    it('contains pad attribute', () => {
      const dot = buildDotString(makeEmptyGraph());
      expect(dot).toContain('pad=');
    });

    it('contains nodesep attribute', () => {
      const dot = buildDotString(makeEmptyGraph());
      expect(dot).toContain('nodesep=');
    });

    it('contains ranksep attribute', () => {
      const dot = buildDotString(makeEmptyGraph());
      expect(dot).toContain('ranksep=');
    });
  });
});
