import * as path from 'path';
import ts from 'typescript';
import { ok, err, type Result } from 'neverthrow';
import type { Logger } from 'pino';
import {
  GRAPH_SCHEMA_VERSION,
  type GraphNode,
  type GraphEdge,
  type FunctionNode,
  type ClassNode,
  type InterfaceNode,
  type TypeAliasNode,
  type ModuleNode,
  type CallEdge,
  type ImportEdge,
  type InheritsEdge,
  type ReferencesEdge,
  type DependencyGraph,
  type ParameterInfo,
  type TypeInfo,
  type PropertyInfo,
} from '../graph/types.js';
import type { ScanResult } from './projectScanner.js';
import { TypeExtractor } from './typeExtractor.js';
import { createSilentLogger } from '../utils/index.js';

// ---------------------------------------------------------------------------
// Public error & options types
// ---------------------------------------------------------------------------

export interface GraphBuilderError {
  readonly kind: 'GraphBuilderError';
  readonly code: 'BUILD_FAILED' | 'UNKNOWN';
  readonly message: string;
  readonly cause?: unknown;
}

export interface BuildGraphOptions {
  /** When true (default), declaration files (.d.ts) are skipped. */
  readonly skipDeclarationFiles?: boolean;
  /**
   * Maximum depth passed to TypeExtractor when resolving nested types.
   * Defaults to 5 (matches TypeExtractor's MAX_DEPTH).
   */
  readonly maxTypeDepth?: number;
}

function makeGraphBuilderError(
  code: GraphBuilderError['code'],
  message: string,
  cause?: unknown,
): GraphBuilderError {
  return { kind: 'GraphBuilderError', code, message, cause };
}

// ---------------------------------------------------------------------------
// GraphBuilder (Builder pattern)
// ---------------------------------------------------------------------------

export class GraphBuilder {
  readonly #nodes = new Map<string, GraphNode>();
  readonly #edges: GraphEdge[] = [];

  addNode(node: GraphNode): this {
    this.#nodes.set(node.id, node);
    return this;
  }

  addEdge(edge: GraphEdge): this {
    this.#edges.push(edge);
    return this;
  }

  hasNode(id: string): boolean {
    return this.#nodes.has(id);
  }

  build(meta: { projectRoot: string; entrypoints: readonly string[] }): DependencyGraph {
    return {
      version: GRAPH_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      projectRoot: meta.projectRoot,
      entrypoints: meta.entrypoints,
      nodes: new Map(this.#nodes) as ReadonlyMap<string, GraphNode>,
      edges: [...this.#edges],
    };
  }
}

// ---------------------------------------------------------------------------
// Internal build context
// ---------------------------------------------------------------------------

interface BuildContext {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly projectRoot: string;
  readonly extractor: TypeExtractor;
  readonly builder: GraphBuilder;
  readonly logger: Logger;
  readonly options: Required<BuildGraphOptions>;
  /** Maps from a TS AST declaration node → graph node ID (set in pass 1). */
  readonly declarationToNodeId: Map<ts.Node, string>;
  /** Maps from absolute source file path → module node ID (set in pass 1). */
  readonly moduleNodeIds: Map<string, string>;
  /** Maps from a simple name string → node ID (for type reference resolution). */
  readonly nameToNodeId: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Pure utility helpers
// ---------------------------------------------------------------------------

/**
 * Builds a stable node ID from the file path (relative to projectRoot),
 * node kind, and node name.
 */
function makeNodeId(relPath: string, kind: string, name: string): string {
  // Normalise to forward slashes for cross-platform stability.
  const normalised = relPath.split(path.sep).join('/');
  return `${normalised}#${kind}:${name}`;
}

/** Returns the path of `absolutePath` relative to `projectRoot`. */
function getRelativePath(absolutePath: string, projectRoot: string): string {
  return path.relative(projectRoot, absolutePath);
}

/** Returns 1-based line and column numbers for a TS node. */
function getLineAndColumn(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): { line: number; column: number } {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: line + 1, column: character + 1 };
}

/** Extracts the text of a `PropertyName`, handling all variants safely. */
function getPropertyName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  if (ts.isPrivateIdentifier(name)) return name.text;
  // Computed property names — fall back to source text.
  return name.getText();
}

/** Returns true when `node` carries an `export` keyword modifier. */
function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  if (modifiers === undefined) return false;
  return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** Returns true when `node` carries an `async` keyword modifier. */
function hasAsyncModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  if (modifiers === undefined) return false;
  return modifiers.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
}

/** Returns the JSDoc comment text for a symbol, or undefined. */
function getJsDocFromSymbol(symbol: ts.Symbol, checker: ts.TypeChecker): string | undefined {
  const parts = symbol.getDocumentationComment(checker);
  if (parts.length === 0) return undefined;
  const text = ts.displayPartsToString(parts).trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Collects the names of all top-level exports in a source file by walking
 * declarations with `export` modifiers and `ExportDeclaration` nodes.
 */
function collectExportedNames(sourceFile: ts.SourceFile): readonly string[] {
  const names: string[] = [];

  for (const statement of sourceFile.statements) {
    // export { a, b } or export { a as b } or export * from '...'
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
        for (const el of statement.exportClause.elements) {
          names.push(el.name.text);
        }
      }
      continue;
    }

    // export default expr
    if (ts.isExportAssignment(statement)) {
      names.push('default');
      continue;
    }

    if (!hasExportModifier(statement)) continue;

    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      names.push(statement.name.text);
    } else if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
      names.push(statement.name.text);
    } else if (ts.isInterfaceDeclaration(statement)) {
      names.push(statement.name.text);
    } else if (ts.isTypeAliasDeclaration(statement)) {
      names.push(statement.name.text);
    } else if (ts.isEnumDeclaration(statement)) {
      names.push(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          names.push(decl.name.text);
        }
      }
    }
  }

  return names;
}

/** Returns the super-class name and list of implemented interface names. */
function getClassHeritage(node: ts.ClassDeclaration): {
  superClass: string | undefined;
  interfaces: readonly string[];
} {
  let superClass: string | undefined;
  const interfaces: string[] = [];

  for (const clause of node.heritageClauses ?? []) {
    if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
      const firstType = clause.types[0];
      if (firstType !== undefined && ts.isIdentifier(firstType.expression)) {
        superClass = firstType.expression.text;
      }
    } else {
      for (const t of clause.types) {
        if (ts.isIdentifier(t.expression)) {
          interfaces.push(t.expression.text);
        }
      }
    }
  }

  return { superClass, interfaces };
}

/** Returns the list of names in an interface's `extends` clause. */
function getInterfaceExtends(node: ts.InterfaceDeclaration): readonly string[] {
  const names: string[] = [];
  for (const clause of node.heritageClauses ?? []) {
    if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
      for (const t of clause.types) {
        if (ts.isIdentifier(t.expression)) {
          names.push(t.expression.text);
        }
      }
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Type extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the parameter list and return type from a function-like node,
 * preferring the compiler's resolved signature when available.
 */
function extractFunctionInfo(
  node: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
  extractor: TypeExtractor,
): { parameters: readonly ParameterInfo[]; returnType: TypeInfo } {
  const signature = checker.getSignatureFromDeclaration(node);

  if (signature !== undefined) {
    const parameters = extractor.extractParameters(signature, checker);
    const returnTypeTs = checker.getReturnTypeOfSignature(signature);
    const returnType = extractor.extractTypeInfo(returnTypeTs, checker);
    return { parameters, returnType };
  }

  // Fallback: manually derive from AST.
  const parameters: ParameterInfo[] = node.parameters.map((param): ParameterInfo => {
    const paramType = checker.getTypeAtLocation(param);
    const typeInfo = extractor.extractTypeInfo(paramType, checker);
    const isOptional = param.questionToken !== undefined || param.initializer !== undefined;
    const isRest = param.dotDotDotToken !== undefined;
    const name = ts.isIdentifier(param.name) ? param.name.text : '_';
    return {
      name,
      typeInfo,
      isOptional,
      isRest,
      ...(param.initializer !== undefined ? { defaultValue: param.initializer.getText() } : {}),
    };
  });

  const returnType: TypeInfo =
    node.type !== undefined
      ? extractor.extractTypeInfo(checker.getTypeFromTypeNode(node.type), checker)
      : { kind: 'unknown', raw: 'unknown' };

  return { parameters, returnType };
}

/**
 * Extracts `PropertyInfo` objects from a class or interface declaration by
 * walking its members.  `MethodSignature` members become properties whose
 * `typeInfo` has `kind: 'function'`.
 */
function extractMemberProperties(
  members: ts.NodeArray<ts.ClassElement | ts.TypeElement>,
  checker: ts.TypeChecker,
  extractor: TypeExtractor,
): readonly PropertyInfo[] {
  const result: PropertyInfo[] = [];

  for (const member of members) {
    if (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) {
      const name = getPropertyName(member.name);
      const propType = checker.getTypeAtLocation(member);
      const typeInfo = extractor.extractTypeInfo(propType, checker);
      const isOptional = member.questionToken !== undefined;
      const isReadonly =
        (ts.getCombinedModifierFlags(member as ts.Declaration) & ts.ModifierFlags.Readonly) !== 0;
      const symbol = checker.getSymbolAtLocation(member.name);
      const jsdoc = symbol !== undefined ? getJsDocFromSymbol(symbol, checker) : undefined;
      result.push({
        name,
        typeInfo,
        isOptional,
        isReadonly,
        ...(jsdoc !== undefined ? { jsdoc } : {}),
      });
    } else if (ts.isMethodSignature(member)) {
      // Interface method signatures are represented as function-typed properties.
      const name = getPropertyName(member.name);
      const signature = checker.getSignatureFromDeclaration(member);
      const parameters: readonly ParameterInfo[] =
        signature !== undefined ? extractor.extractParameters(signature, checker) : [];
      const returnTypeTs =
        signature !== undefined ? checker.getReturnTypeOfSignature(signature) : undefined;
      const returnType: TypeInfo =
        returnTypeTs !== undefined
          ? extractor.extractTypeInfo(returnTypeTs, checker)
          : { kind: 'unknown', raw: 'unknown' };
      const funcTypeInfo: TypeInfo = { kind: 'function', parameters, returnType };
      const isOptional = member.questionToken !== undefined;
      const symbol = checker.getSymbolAtLocation(member.name);
      const jsdoc = symbol !== undefined ? getJsDocFromSymbol(symbol, checker) : undefined;
      result.push({
        name,
        typeInfo: funcTypeInfo,
        isOptional,
        isReadonly: false,
        ...(jsdoc !== undefined ? { jsdoc } : {}),
      });
    }
    // Index signatures, call signatures, construct signatures — skipped.
  }

  return result;
}

/**
 * Extracts `FunctionNode` objects for the methods of a class declaration.
 * The returned nodes' IDs use the pattern `relPath#function:ClassName.methodName`.
 */
function extractClassMethods(
  classNode: ts.ClassDeclaration,
  className: string,
  relPath: string,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  extractor: TypeExtractor,
  declarationToNodeId: Map<ts.Node, string>,
): readonly FunctionNode[] {
  const methods: FunctionNode[] = [];

  for (const member of classNode.members) {
    if (!ts.isMethodDeclaration(member) && !ts.isConstructorDeclaration(member)) {
      continue;
    }

    let methodName: string;
    if (ts.isConstructorDeclaration(member)) {
      methodName = 'constructor';
    } else {
      methodName = getPropertyName(member.name);
    }

    const id = makeNodeId(relPath, 'function', `${className}.${methodName}`);
    const pos = getLineAndColumn(member, sourceFile);
    const isAsync = hasAsyncModifier(member);
    const isExported = hasExportModifier(member);
    const { parameters, returnType } = extractFunctionInfo(member, checker, extractor);

    const symbol = ts.isConstructorDeclaration(member)
      ? undefined
      : checker.getSymbolAtLocation(member.name);
    const jsdoc = symbol !== undefined ? getJsDocFromSymbol(symbol, checker) : undefined;

    const funcNode: FunctionNode = {
      kind: 'function',
      id,
      name: `${className}.${methodName}`,
      filePath: relPath,
      line: pos.line,
      column: pos.column,
      isAsync,
      isExported,
      parameters,
      returnType,
      ...(jsdoc !== undefined ? { jsdoc } : {}),
    };

    methods.push(funcNode);
    declarationToNodeId.set(member, id);
  }

  return methods;
}

// ---------------------------------------------------------------------------
// Pass 1 — build nodes
// ---------------------------------------------------------------------------

function processFunctionDeclaration(
  node: ts.FunctionDeclaration,
  sourceFile: ts.SourceFile,
  relPath: string,
  ctx: BuildContext,
): void {
  if (node.name === undefined) return; // unnamed function declaration
  const name = node.name.text;
  const id = makeNodeId(relPath, 'function', name);
  const pos = getLineAndColumn(node, sourceFile);
  const isAsync = hasAsyncModifier(node);
  const isExported = hasExportModifier(node);
  const { parameters, returnType } = extractFunctionInfo(node, ctx.checker, ctx.extractor);
  const symbol = ctx.checker.getSymbolAtLocation(node.name);
  const jsdoc = symbol !== undefined ? getJsDocFromSymbol(symbol, ctx.checker) : undefined;

  const funcNode: FunctionNode = {
    kind: 'function',
    id,
    name,
    filePath: relPath,
    line: pos.line,
    column: pos.column,
    isAsync,
    isExported,
    parameters,
    returnType,
    ...(jsdoc !== undefined ? { jsdoc } : {}),
  };

  ctx.builder.addNode(funcNode);
  ctx.declarationToNodeId.set(node, id);
  ctx.nameToNodeId.set(name, id);
}

function processVariableStatement(
  node: ts.VariableStatement,
  sourceFile: ts.SourceFile,
  relPath: string,
  ctx: BuildContext,
): void {
  const isExported = hasExportModifier(node);

  for (const decl of node.declarationList.declarations) {
    if (!ts.isIdentifier(decl.name)) continue;
    const { initializer } = decl;
    if (
      initializer === undefined ||
      (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer))
    ) {
      continue;
    }

    const name = decl.name.text;
    const id = makeNodeId(relPath, 'function', name);
    const pos = getLineAndColumn(decl, sourceFile);
    const isAsync = hasAsyncModifier(initializer);
    const { parameters, returnType } = extractFunctionInfo(initializer, ctx.checker, ctx.extractor);
    const symbol = ctx.checker.getSymbolAtLocation(decl.name);
    const jsdoc = symbol !== undefined ? getJsDocFromSymbol(symbol, ctx.checker) : undefined;

    const funcNode: FunctionNode = {
      kind: 'function',
      id,
      name,
      filePath: relPath,
      line: pos.line,
      column: pos.column,
      isAsync,
      isExported,
      parameters,
      returnType,
      ...(jsdoc !== undefined ? { jsdoc } : {}),
    };

    ctx.builder.addNode(funcNode);
    ctx.declarationToNodeId.set(decl, id);
    ctx.declarationToNodeId.set(initializer, id);
    ctx.nameToNodeId.set(name, id);
  }
}

function processClassDeclaration(
  node: ts.ClassDeclaration,
  sourceFile: ts.SourceFile,
  relPath: string,
  ctx: BuildContext,
): void {
  if (node.name === undefined) return; // anonymous class expression at statement level
  const name = node.name.text;
  const id = makeNodeId(relPath, 'class', name);
  const pos = getLineAndColumn(node, sourceFile);
  const isExported = hasExportModifier(node);
  const { superClass, interfaces } = getClassHeritage(node);

  const methods = extractClassMethods(
    node,
    name,
    relPath,
    sourceFile,
    ctx.checker,
    ctx.extractor,
    ctx.declarationToNodeId,
  );

  // Add each method as a top-level node as well (so edges can point to them).
  for (const m of methods) {
    ctx.builder.addNode(m);
  }

  const properties = extractMemberProperties(
    node.members as ts.NodeArray<ts.ClassElement | ts.TypeElement>,
    ctx.checker,
    ctx.extractor,
  );

  const classNode: ClassNode = {
    kind: 'class',
    id,
    name,
    filePath: relPath,
    line: pos.line,
    column: pos.column,
    isExported,
    interfaces,
    methods,
    properties,
    ...(superClass !== undefined ? { superClass } : {}),
  };

  ctx.builder.addNode(classNode);
  ctx.declarationToNodeId.set(node, id);
  ctx.nameToNodeId.set(name, id);
}

function processInterfaceDeclaration(
  node: ts.InterfaceDeclaration,
  sourceFile: ts.SourceFile,
  relPath: string,
  ctx: BuildContext,
): void {
  const name = node.name.text;
  const id = makeNodeId(relPath, 'interface', name);
  const pos = getLineAndColumn(node, sourceFile);
  const isExported = hasExportModifier(node);
  const extendsNames = getInterfaceExtends(node);
  const properties = extractMemberProperties(
    node.members as ts.NodeArray<ts.ClassElement | ts.TypeElement>,
    ctx.checker,
    ctx.extractor,
  );

  const ifaceNode: InterfaceNode = {
    kind: 'interface',
    id,
    name,
    filePath: relPath,
    line: pos.line,
    column: pos.column,
    isExported,
    extends: extendsNames,
    properties,
  };

  ctx.builder.addNode(ifaceNode);
  ctx.declarationToNodeId.set(node, id);
  ctx.nameToNodeId.set(name, id);
}

function processTypeAliasDeclaration(
  node: ts.TypeAliasDeclaration,
  sourceFile: ts.SourceFile,
  relPath: string,
  ctx: BuildContext,
): void {
  const name = node.name.text;
  const id = makeNodeId(relPath, 'typeAlias', name);
  const pos = getLineAndColumn(node, sourceFile);
  const isExported = hasExportModifier(node);
  const aliasType = ctx.checker.getTypeAtLocation(node.type);
  const typeInfo = ctx.extractor.extractTypeInfo(aliasType, ctx.checker);

  const aliasNode: TypeAliasNode = {
    kind: 'typeAlias',
    id,
    name,
    filePath: relPath,
    line: pos.line,
    column: pos.column,
    isExported,
    typeInfo,
  };

  ctx.builder.addNode(aliasNode);
  ctx.declarationToNodeId.set(node, id);
  ctx.nameToNodeId.set(name, id);
}

/** Pass 1: Creates all graph nodes from a single source file. */
function buildNodesForSourceFile(sourceFile: ts.SourceFile, ctx: BuildContext): void {
  const relPath = getRelativePath(sourceFile.fileName, ctx.projectRoot);
  const moduleName = path.basename(sourceFile.fileName, path.extname(sourceFile.fileName));
  const moduleId = makeNodeId(relPath, 'module', moduleName);

  const exportedNames = collectExportedNames(sourceFile);

  const moduleNode: ModuleNode = {
    kind: 'module',
    id: moduleId,
    name: moduleName,
    filePath: relPath,
    exports: exportedNames,
  };

  ctx.builder.addNode(moduleNode);
  ctx.moduleNodeIds.set(sourceFile.fileName, moduleId);

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      processFunctionDeclaration(statement, sourceFile, relPath, ctx);
    } else if (ts.isVariableStatement(statement)) {
      processVariableStatement(statement, sourceFile, relPath, ctx);
    } else if (ts.isClassDeclaration(statement)) {
      processClassDeclaration(statement, sourceFile, relPath, ctx);
    } else if (ts.isInterfaceDeclaration(statement)) {
      processInterfaceDeclaration(statement, sourceFile, relPath, ctx);
    } else if (ts.isTypeAliasDeclaration(statement)) {
      processTypeAliasDeclaration(statement, sourceFile, relPath, ctx);
    }
  }
}

// ---------------------------------------------------------------------------
// Pass 2 — build edges
// ---------------------------------------------------------------------------

/** Resolves an import specifier string to the absolute path of the target file. */
function resolveImportSpecifier(
  specifier: string,
  fromFile: string,
  program: ts.Program,
): string | undefined {
  const compilerOptions = program.getCompilerOptions();
  const result = ts.resolveModuleName(specifier, fromFile, compilerOptions, ts.sys);
  return result.resolvedModule?.resolvedFileName;
}

/** Collects all type-reference names used in a TypeNode (recursive). */
function collectTypeReferenceNames(typeNode: ts.TypeNode | undefined): readonly string[] {
  if (typeNode === undefined) return [];
  const names: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      names.push(node.typeName.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(typeNode);

  return names;
}

/** Emits ImportEdges for every ImportDeclaration in the source file. */
function buildImportEdges(sourceFile: ts.SourceFile, ctx: BuildContext): void {
  const fromModuleId = ctx.moduleNodeIds.get(sourceFile.fileName);
  if (fromModuleId === undefined) return;

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const { moduleSpecifier, importClause } = statement;
    if (!ts.isStringLiteral(moduleSpecifier)) continue;

    const specifierText = moduleSpecifier.text;
    const resolvedFile = resolveImportSpecifier(specifierText, sourceFile.fileName, ctx.program);
    if (resolvedFile === undefined) continue;

    const toModuleId = ctx.moduleNodeIds.get(resolvedFile);
    if (toModuleId === undefined) continue; // external / unanalysed module

    const importedNames: string[] = [];
    const isTypeOnly = importClause?.isTypeOnly ?? false;

    if (importClause !== undefined) {
      if (importClause.name !== undefined) {
        importedNames.push('default');
      }
      const { namedBindings } = importClause;
      if (namedBindings !== undefined) {
        if (ts.isNamespaceImport(namedBindings)) {
          importedNames.push('*');
        } else {
          for (const el of namedBindings.elements) {
            importedNames.push(el.name.text);
          }
        }
      }
    }

    const edge: ImportEdge = {
      kind: 'import',
      from: fromModuleId,
      to: toModuleId,
      importedNames,
      isTypeOnly,
    };
    ctx.builder.addEdge(edge);
  }
}

/**
 * Emits InheritsEdges for every `extends`/`implements` clause in class and
 * interface declarations inside the source file.
 */
function buildInheritsEdges(sourceFile: ts.SourceFile, ctx: BuildContext): void {
  for (const statement of sourceFile.statements) {
    if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
      const fromId = ctx.declarationToNodeId.get(statement);
      if (fromId === undefined) continue;

      const { superClass, interfaces } = getClassHeritage(statement);

      if (superClass !== undefined) {
        const toId = resolveNameToNodeId(superClass, statement, ctx);
        if (toId !== undefined) {
          const edge: InheritsEdge = { kind: 'inherits', from: fromId, to: toId };
          ctx.builder.addEdge(edge);
        }
      }

      for (const ifaceName of interfaces) {
        const toId = resolveNameToNodeId(ifaceName, statement, ctx);
        if (toId !== undefined) {
          const edge: InheritsEdge = { kind: 'inherits', from: fromId, to: toId };
          ctx.builder.addEdge(edge);
        }
      }
    } else if (ts.isInterfaceDeclaration(statement)) {
      const fromId = ctx.declarationToNodeId.get(statement);
      if (fromId === undefined) continue;

      for (const baseName of getInterfaceExtends(statement)) {
        const toId = resolveNameToNodeId(baseName, statement, ctx);
        if (toId !== undefined) {
          const edge: InheritsEdge = { kind: 'inherits', from: fromId, to: toId };
          ctx.builder.addEdge(edge);
        }
      }
    }
  }
}

/**
 * Emits ReferencesEdges for type references found in function parameter
 * type annotations and return type annotations.
 */
function buildReferencesEdges(sourceFile: ts.SourceFile, ctx: BuildContext): void {
  function visitFunctionLike(node: ts.FunctionLikeDeclaration, containerId: string): void {
    const allTypeRefNames: string[] = [];

    for (const param of node.parameters) {
      allTypeRefNames.push(...collectTypeReferenceNames(param.type));
    }
    allTypeRefNames.push(...collectTypeReferenceNames(node.type));

    for (const refName of new Set(allTypeRefNames)) {
      const toId = resolveNameToNodeId(refName, node, ctx);
      if (toId !== undefined && toId !== containerId) {
        const edge: ReferencesEdge = { kind: 'references', from: containerId, to: toId };
        ctx.builder.addEdge(edge);
      }
    }
  }

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      const nodeId = ctx.declarationToNodeId.get(statement);
      if (nodeId !== undefined) visitFunctionLike(statement, nodeId);
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        const { initializer } = decl;
        if (
          initializer !== undefined &&
          (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        ) {
          const nodeId = ctx.declarationToNodeId.get(decl);
          if (nodeId !== undefined) visitFunctionLike(initializer, nodeId);
        }
      }
    } else if (ts.isClassDeclaration(statement)) {
      for (const member of statement.members) {
        if (ts.isMethodDeclaration(member)) {
          const nodeId = ctx.declarationToNodeId.get(member);
          if (nodeId !== undefined) visitFunctionLike(member, nodeId);
        }
      }
    }
  }
}

/**
 * Emits CallEdges by walking the AST of the source file and resolving
 * CallExpression callees to known node IDs via the type checker.
 */
function buildCallEdges(sourceFile: ts.SourceFile, ctx: BuildContext): void {
  const moduleId = ctx.moduleNodeIds.get(sourceFile.fileName);
  if (moduleId === undefined) return;

  /**
   * Walk the subtree rooted at `node`, emitting CallEdges when a callee
   * resolves to a known function node.  `containerNodeId` tracks the nearest
   * enclosing function or the module.
   */
  function walk(node: ts.Node, containerNodeId: string): void {
    // Update container when we enter a function-like node we know about.
    let currentContainer = containerNodeId;
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node)
    ) {
      const knownId = ctx.declarationToNodeId.get(node);
      if (knownId !== undefined) currentContainer = knownId;
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const symbol = ctx.checker.getSymbolAtLocation(callee);
      if (symbol !== undefined) {
        const targetId = resolveSymbolToNodeId(symbol, ctx);
        if (targetId !== undefined && targetId !== currentContainer) {
          const pos = getLineAndColumn(node, sourceFile);
          const edge: CallEdge = {
            kind: 'call',
            from: currentContainer,
            to: targetId,
            line: pos.line,
          };
          ctx.builder.addEdge(edge);
        }
      }
    }

    ts.forEachChild(node, (child) => {
      walk(child, currentContainer);
    });
  }

  walk(sourceFile, moduleId);
}

/** Pass 2: Creates all edges for a single source file. */
function buildEdgesForSourceFile(sourceFile: ts.SourceFile, ctx: BuildContext): void {
  buildImportEdges(sourceFile, ctx);
  buildInheritsEdges(sourceFile, ctx);
  buildReferencesEdges(sourceFile, ctx);
  buildCallEdges(sourceFile, ctx);
}

// ---------------------------------------------------------------------------
// Symbol / name resolution helpers (used in pass 2)
// ---------------------------------------------------------------------------

/**
 * Tries to resolve a simple name string to a graph node ID by:
 * 1. Looking up the name via the type checker at the call site.
 * 2. Falling back to the `nameToNodeId` map built during pass 1.
 */
function resolveNameToNodeId(
  name: string,
  referenceNode: ts.Node,
  ctx: BuildContext,
): string | undefined {
  // Prefer the type-checker's symbol resolution so cross-file references work.
  const sourceFile = referenceNode.getSourceFile();
  // Walk up to find a scope that contains the name — search in the source file.
  const sym = ctx.checker.resolveName(
    name,
    referenceNode,
    ts.SymbolFlags.Type | ts.SymbolFlags.Value | ts.SymbolFlags.Namespace,
    false,
  );
  if (sym !== undefined) {
    const id = resolveSymbolToNodeId(sym, ctx);
    if (id !== undefined) return id;
  }
  // Fallback: simple name look-up built during pass 1.
  void sourceFile; // keep sourceFile in scope for future use
  return ctx.nameToNodeId.get(name);
}

/**
 * Resolves a TypeScript symbol to a graph node ID by finding the symbol's
 * declaration in `declarationToNodeId`.  Follows aliased symbols (e.g. named
 * imports).
 */
function resolveSymbolToNodeId(sym: ts.Symbol, ctx: BuildContext): string | undefined {
  // Follow aliases (import binding → actual declaration).
  const resolvedSym =
    (sym.getFlags() & ts.SymbolFlags.Alias) !== 0 ? ctx.checker.getAliasedSymbol(sym) : sym;

  for (const decl of resolvedSym.declarations ?? []) {
    const id = ctx.declarationToNodeId.get(decl);
    if (id !== undefined) return id;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// buildGraph — public API
// ---------------------------------------------------------------------------

/**
 * Builds a complete `DependencyGraph` from a `ScanResult`.
 *
 * Pass 1 creates one `ModuleNode` per source file and one typed node per
 * top-level declaration.  Pass 2 adds `ImportEdge`, `CallEdge`,
 * `InheritsEdge`, and `ReferencesEdge` connections between those nodes.
 *
 * The returned `DependencyGraph` contains only plain serialisable data — the
 * `ts.Program` from the `ScanResult` is not included.
 */
export function buildGraph(
  scanResult: ScanResult,
  options: BuildGraphOptions = {},
  logger?: Logger,
): Result<DependencyGraph, GraphBuilderError> {
  const log = logger ?? createSilentLogger();

  try {
    const resolvedOptions: Required<BuildGraphOptions> = {
      skipDeclarationFiles: options.skipDeclarationFiles ?? true,
      maxTypeDepth: options.maxTypeDepth ?? 5,
    };

    const builder = new GraphBuilder();
    const checker = scanResult.program.getTypeChecker();
    const extractor = new TypeExtractor();

    const ctx: BuildContext = {
      program: scanResult.program,
      checker,
      projectRoot: scanResult.projectRoot,
      extractor,
      builder,
      logger: log,
      options: resolvedOptions,
      declarationToNodeId: new Map(),
      moduleNodeIds: new Map(),
      nameToNodeId: new Map(),
    };

    const allSourceFiles = scanResult.program.getSourceFiles();

    // ---- Pass 1: build nodes ------------------------------------------------
    log.debug({ fileCount: allSourceFiles.length }, 'GraphBuilder pass 1: building nodes');

    for (const sourceFile of allSourceFiles) {
      if (resolvedOptions.skipDeclarationFiles && sourceFile.isDeclarationFile) {
        continue;
      }
      // Skip files outside the project root (e.g. library types).
      const rel = getRelativePath(sourceFile.fileName, scanResult.projectRoot);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        continue;
      }

      log.trace({ file: rel }, 'processing source file (pass 1)');
      buildNodesForSourceFile(sourceFile, ctx);
    }

    log.debug('GraphBuilder pass 1 complete');

    // ---- Pass 2: build edges ------------------------------------------------
    log.debug('GraphBuilder pass 2: building edges');

    for (const sourceFile of allSourceFiles) {
      if (resolvedOptions.skipDeclarationFiles && sourceFile.isDeclarationFile) {
        continue;
      }
      const rel = getRelativePath(sourceFile.fileName, scanResult.projectRoot);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        continue;
      }

      log.trace({ file: rel }, 'processing source file (pass 2)');
      buildEdgesForSourceFile(sourceFile, ctx);
    }

    log.debug('GraphBuilder pass 2 complete');

    const graph = builder.build({
      projectRoot: scanResult.projectRoot,
      entrypoints: scanResult.entrypoints,
    });

    log.info(
      { nodes: graph.nodes.size, edges: graph.edges.length },
      'Dependency graph built successfully',
    );

    return ok(graph);
  } catch (cause) {
    const message = `Failed to build dependency graph: ${String(cause)}`;
    log.error({ cause }, message);
    return err(makeGraphBuilderError('BUILD_FAILED', message, cause));
  }
}
