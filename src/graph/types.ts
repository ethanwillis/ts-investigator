// ---------------------------------------------------------------------------
// Schema Version
// ---------------------------------------------------------------------------

export const GRAPH_SCHEMA_VERSION = '1.0' as const;

// ---------------------------------------------------------------------------
// Type Metadata
// ---------------------------------------------------------------------------

export interface ParameterInfo {
  readonly name: string;
  readonly typeInfo: TypeInfo;
  readonly isOptional: boolean;
  readonly isRest: boolean;
  readonly defaultValue?: string;
}

export interface PropertyInfo {
  readonly name: string;
  readonly typeInfo: TypeInfo;
  readonly isOptional: boolean;
  readonly isReadonly: boolean;
  readonly jsdoc?: string;
}

export type TypeInfo =
  | {
      readonly kind: 'primitive';
      readonly name:
        | 'string'
        | 'number'
        | 'boolean'
        | 'null'
        | 'undefined'
        | 'void'
        | 'never'
        | 'unknown'
        | 'any';
    }
  | {
      readonly kind: 'literal';
      readonly value: string | number | boolean;
    }
  | {
      readonly kind: 'array';
      readonly elementType: TypeInfo;
    }
  | {
      readonly kind: 'tuple';
      readonly elements: readonly TypeInfo[];
    }
  | {
      readonly kind: 'union';
      readonly members: readonly TypeInfo[];
    }
  | {
      readonly kind: 'intersection';
      readonly members: readonly TypeInfo[];
    }
  | {
      readonly kind: 'object';
      readonly properties: readonly PropertyInfo[];
    }
  | {
      readonly kind: 'reference';
      readonly name: string;
      readonly typeArguments: readonly TypeInfo[];
    }
  | {
      readonly kind: 'function';
      readonly parameters: readonly ParameterInfo[];
      readonly returnType: TypeInfo;
    }
  | {
      readonly kind: 'unknown';
      readonly raw: string;
    };

// ---------------------------------------------------------------------------
// Graph Nodes
// ---------------------------------------------------------------------------

export interface FunctionNode {
  readonly kind: 'function';
  readonly id: string;
  readonly name: string;
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly isAsync: boolean;
  readonly isExported: boolean;
  readonly parameters: readonly ParameterInfo[];
  readonly returnType: TypeInfo;
  readonly jsdoc?: string;
}

export interface ClassNode {
  readonly kind: 'class';
  readonly id: string;
  readonly name: string;
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly isExported: boolean;
  readonly superClass?: string;
  readonly interfaces: readonly string[];
  readonly methods: readonly FunctionNode[];
  readonly properties: readonly PropertyInfo[];
}

export interface InterfaceNode {
  readonly kind: 'interface';
  readonly id: string;
  readonly name: string;
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly isExported: boolean;
  readonly extends: readonly string[];
  readonly properties: readonly PropertyInfo[];
}

export interface TypeAliasNode {
  readonly kind: 'typeAlias';
  readonly id: string;
  readonly name: string;
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly isExported: boolean;
  readonly typeInfo: TypeInfo;
}

export interface ModuleNode {
  readonly kind: 'module';
  readonly id: string;
  readonly name: string;
  readonly filePath: string;
  readonly exports: readonly string[];
}

export type GraphNode = FunctionNode | ClassNode | InterfaceNode | TypeAliasNode | ModuleNode;

// ---------------------------------------------------------------------------
// Graph Edges
// ---------------------------------------------------------------------------

export interface CallEdge {
  readonly kind: 'call';
  readonly from: string;
  readonly to: string;
  readonly line: number;
}

export interface ImportEdge {
  readonly kind: 'import';
  readonly from: string;
  readonly to: string;
  readonly importedNames: readonly string[];
  readonly isTypeOnly: boolean;
}

export interface InheritsEdge {
  readonly kind: 'inherits';
  readonly from: string;
  readonly to: string;
}

export interface ReferencesEdge {
  readonly kind: 'references';
  readonly from: string;
  readonly to: string;
}

export type GraphEdge = CallEdge | ImportEdge | InheritsEdge | ReferencesEdge;

// ---------------------------------------------------------------------------
// Top-level Dependency Graph
// ---------------------------------------------------------------------------

export interface DependencyGraph {
  readonly version: string;
  readonly generatedAt: string;
  readonly projectRoot: string;
  readonly entrypoints: readonly string[];
  readonly nodes: ReadonlyMap<string, GraphNode>;
  readonly edges: readonly GraphEdge[];
}
