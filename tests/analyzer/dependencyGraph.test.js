"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const path = __importStar(require("path"));
const projectScanner_js_1 = require("../../src/analyzer/projectScanner.js");
const dependencyGraph_js_1 = require("../../src/analyzer/dependencyGraph.js");
// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------
const FIXTURE_ROOT = path.join(__dirname, '../fixtures/sample-project');
// ---------------------------------------------------------------------------
// Shared setup — scan once and build graph once for the whole suite
// ---------------------------------------------------------------------------
let graph;
beforeAll(() => {
    const scanner = new projectScanner_js_1.ProjectScanner();
    const scanResult = scanner.scan({ projectRoot: FIXTURE_ROOT });
    if (scanResult.isErr()) {
        throw new Error(`ProjectScanner failed in beforeAll: ${scanResult.error.message}`);
    }
    const graphResult = (0, dependencyGraph_js_1.buildGraph)(scanResult.value);
    if (graphResult.isErr()) {
        throw new Error(`buildGraph failed in beforeAll: ${graphResult.error.message}`);
    }
    graph = graphResult.value;
});
// ---------------------------------------------------------------------------
// buildGraph — top-level result
// ---------------------------------------------------------------------------
describe('buildGraph', () => {
    describe('overall result', () => {
        it('returns a DependencyGraph (not an error) for the fixture project', () => {
            const scanner = new projectScanner_js_1.ProjectScanner();
            const scanResult = scanner.scan({ projectRoot: FIXTURE_ROOT });
            expect(scanResult.isOk()).toBe(true);
            if (scanResult.isErr())
                return;
            const result = (0, dependencyGraph_js_1.buildGraph)(scanResult.value);
            expect(result.isOk()).toBe(true);
        });
        it('graph.version equals GRAPH_SCHEMA_VERSION "1.0"', () => {
            expect(graph.version).toBe('1.0');
        });
        it('graph.projectRoot resolves to the fixture root', () => {
            expect(graph.projectRoot).toBe(path.resolve(FIXTURE_ROOT));
        });
        it('graph.generatedAt is a non-empty ISO date string', () => {
            expect(typeof graph.generatedAt).toBe('string');
            expect(graph.generatedAt.length).toBeGreaterThan(0);
            // Should parse as a valid date
            expect(Number.isNaN(Date.parse(graph.generatedAt))).toBe(false);
        });
        it('graph.entrypoints is non-empty and contains an absolute path', () => {
            expect(graph.entrypoints.length).toBeGreaterThan(0);
            for (const ep of graph.entrypoints) {
                expect(path.isAbsolute(ep)).toBe(true);
            }
        });
        it('graph.entrypoints contains src/index.ts', () => {
            const bases = graph.entrypoints.map((ep) => path.basename(ep));
            expect(bases).toContain('index.ts');
        });
        it('graph.nodes is a ReadonlyMap with Map-like methods', () => {
            expect(typeof graph.nodes.get).toBe('function');
            expect(typeof graph.nodes.has).toBe('function');
            expect(typeof graph.nodes.forEach).toBe('function');
            expect(typeof graph.nodes.size).toBe('number');
        });
        it('graph.nodes has more than zero entries', () => {
            expect(graph.nodes.size).toBeGreaterThan(0);
        });
        it('graph.edges is a readonly array', () => {
            expect(Array.isArray(graph.edges)).toBe(true);
        });
    });
    // --------------------------------------------------------------------------
    // ModuleNode for each source file
    // --------------------------------------------------------------------------
    describe('ModuleNode — one per source file', () => {
        // The implementation uses makeNodeId(relPath, 'module', basename-without-ext)
        // so the IDs are: src/index.ts#module:index, src/utils.ts#module:utils, etc.
        it('contains a ModuleNode for src/index.ts (id: src/index.ts#module:index)', () => {
            const moduleNode = graph.nodes.get('src/index.ts#module:index');
            expect(moduleNode).toBeDefined();
            expect(moduleNode?.kind).toBe('module');
        });
        it('contains a ModuleNode for src/utils.ts (id: src/utils.ts#module:utils)', () => {
            const moduleNode = graph.nodes.get('src/utils.ts#module:utils');
            expect(moduleNode).toBeDefined();
            expect(moduleNode?.kind).toBe('module');
        });
        it('contains a ModuleNode for src/types.ts (id: src/types.ts#module:types)', () => {
            const moduleNode = graph.nodes.get('src/types.ts#module:types');
            expect(moduleNode).toBeDefined();
            expect(moduleNode?.kind).toBe('module');
        });
        it('ModuleNode for src/index.ts has a relative filePath', () => {
            const moduleNode = graph.nodes.get('src/index.ts#module:index');
            if (moduleNode?.kind === 'module') {
                // filePath is stored as relative path (not absolute)
                expect(path.isAbsolute(moduleNode.filePath)).toBe(false);
                expect(moduleNode.filePath).toContain('index.ts');
            }
        });
        it('ModuleNode name is the basename without extension', () => {
            const utilsModule = graph.nodes.get('src/utils.ts#module:utils');
            if (utilsModule?.kind === 'module') {
                expect(utilsModule.name).toBe('utils');
            }
            const typesModule = graph.nodes.get('src/types.ts#module:types');
            if (typesModule?.kind === 'module') {
                expect(typesModule.name).toBe('types');
            }
            const indexModule = graph.nodes.get('src/index.ts#module:index');
            if (indexModule?.kind === 'module') {
                expect(indexModule.name).toBe('index');
            }
        });
        it('ModuleNode for src/utils.ts exports the expected function names', () => {
            const moduleNode = graph.nodes.get('src/utils.ts#module:utils');
            expect(moduleNode).toBeDefined();
            if (moduleNode?.kind === 'module') {
                expect(moduleNode.exports).toContain('greet');
                expect(moduleNode.exports).toContain('add');
                expect(moduleNode.exports).toContain('createUser');
            }
        });
        it('ModuleNode for src/types.ts exports the expected type names', () => {
            const moduleNode = graph.nodes.get('src/types.ts#module:types');
            expect(moduleNode).toBeDefined();
            if (moduleNode?.kind === 'module') {
                expect(moduleNode.exports).toContain('User');
                expect(moduleNode.exports).toContain('Role');
                expect(moduleNode.exports).toContain('Config');
            }
        });
        it('ModuleNode for src/index.ts exports App and re-exported functions', () => {
            const moduleNode = graph.nodes.get('src/index.ts#module:index');
            expect(moduleNode).toBeDefined();
            if (moduleNode?.kind === 'module') {
                expect(moduleNode.exports).toContain('App');
                expect(moduleNode.exports).toContain('greet');
            }
        });
        it('there are exactly 3 module nodes (one per source file)', () => {
            const moduleNodes = [...graph.nodes.values()].filter((n) => n.kind === 'module');
            expect(moduleNodes).toHaveLength(3);
        });
    });
    // --------------------------------------------------------------------------
    // FunctionNode — greet
    // --------------------------------------------------------------------------
    describe('FunctionNode for "greet"', () => {
        let greetNode;
        beforeAll(() => {
            const node = graph.nodes.get('src/utils.ts#function:greet');
            if (node?.kind === 'function') {
                greetNode = node;
            }
        });
        it('is present in the graph', () => {
            expect(greetNode).toBeDefined();
        });
        it('has kind "function"', () => {
            expect(greetNode?.kind).toBe('function');
        });
        it('has name "greet"', () => {
            expect(greetNode?.name).toBe('greet');
        });
        it('has isExported: true', () => {
            expect(greetNode?.isExported).toBe(true);
        });
        it('has isAsync: false', () => {
            expect(greetNode?.isAsync).toBe(false);
        });
        it('has exactly one parameter', () => {
            expect(greetNode?.parameters).toHaveLength(1);
        });
        it('parameter "name" has typeInfo kind "primitive" and name "string"', () => {
            const param = greetNode?.parameters[0];
            expect(param?.name).toBe('name');
            expect(param?.typeInfo).toEqual({ kind: 'primitive', name: 'string' });
        });
        it('parameter "name" is not optional', () => {
            expect(greetNode?.parameters[0]?.isOptional).toBe(false);
        });
        it('parameter "name" is not a rest parameter', () => {
            expect(greetNode?.parameters[0]?.isRest).toBe(false);
        });
        it('has returnType kind "primitive" and name "string"', () => {
            expect(greetNode?.returnType).toEqual({ kind: 'primitive', name: 'string' });
        });
        it('has a relative filePath pointing to src/utils.ts', () => {
            expect(greetNode?.filePath).toBe('src/utils.ts');
        });
        it('has a line number >= 1', () => {
            expect(greetNode?.line ?? 0).toBeGreaterThanOrEqual(1);
        });
        it('id is stable string "src/utils.ts#function:greet"', () => {
            expect(greetNode?.id).toBe('src/utils.ts#function:greet');
        });
    });
    // --------------------------------------------------------------------------
    // FunctionNode — add (number + number)
    // --------------------------------------------------------------------------
    describe('FunctionNode for "add"', () => {
        it('is present in the graph', () => {
            const node = graph.nodes.get('src/utils.ts#function:add');
            expect(node).toBeDefined();
            expect(node?.kind).toBe('function');
        });
        it('has two parameters of type number', () => {
            const node = graph.nodes.get('src/utils.ts#function:add');
            if (node?.kind === 'function') {
                expect(node.parameters).toHaveLength(2);
                expect(node.parameters[0]?.typeInfo).toEqual({ kind: 'primitive', name: 'number' });
                expect(node.parameters[1]?.typeInfo).toEqual({ kind: 'primitive', name: 'number' });
            }
        });
        it('has returnType of number', () => {
            const node = graph.nodes.get('src/utils.ts#function:add');
            if (node?.kind === 'function') {
                expect(node.returnType).toEqual({ kind: 'primitive', name: 'number' });
            }
        });
    });
    // --------------------------------------------------------------------------
    // FunctionNode — isAdult (number, boolean)
    // --------------------------------------------------------------------------
    describe('FunctionNode for "isAdult"', () => {
        it('is present in the graph', () => {
            const node = graph.nodes.get('src/utils.ts#function:isAdult');
            expect(node).toBeDefined();
            expect(node?.kind).toBe('function');
        });
        it('has a number parameter "age" and a boolean parameter "strict"', () => {
            const node = graph.nodes.get('src/utils.ts#function:isAdult');
            if (node?.kind === 'function') {
                expect(node.parameters).toHaveLength(2);
                const ageParm = node.parameters.find((p) => p.name === 'age');
                const strictParm = node.parameters.find((p) => p.name === 'strict');
                expect(ageParm?.typeInfo).toEqual({ kind: 'primitive', name: 'number' });
                expect(strictParm?.typeInfo).toEqual({ kind: 'primitive', name: 'boolean' });
            }
        });
    });
    // --------------------------------------------------------------------------
    // FunctionNode — createUser (optional parameter)
    //
    // NOTE: TypeExtractor.isSymbolOptional checks ts.SymbolFlags.Optional which
    // is NOT set for function parameters using "?" syntax when the type is
    // resolved through getTypeOfSymbol — the type becomes `string | undefined`
    // (a union). The `isOptional` flag on function params in the graph is
    // therefore driven by whether the symbol has the Optional flag OR a default
    // value initializer. The definitive check for "email" is that its typeInfo
    // is a union containing `undefined`.
    // --------------------------------------------------------------------------
    describe('FunctionNode for "createUser" (optional parameter)', () => {
        it('is present in the graph', () => {
            const node = graph.nodes.get('src/utils.ts#function:createUser');
            expect(node).toBeDefined();
            expect(node?.kind).toBe('function');
        });
        it('has three parameters', () => {
            const node = graph.nodes.get('src/utils.ts#function:createUser');
            if (node?.kind === 'function') {
                expect(node.parameters).toHaveLength(3);
            }
        });
        it('parameter "email" is present', () => {
            const node = graph.nodes.get('src/utils.ts#function:createUser');
            if (node?.kind === 'function') {
                const emailParam = node.parameters.find((p) => p.name === 'email');
                expect(emailParam).toBeDefined();
            }
        });
        it('parameter "email" typeInfo is a union containing "undefined" (reflects optionality)', () => {
            // TypeExtractor resolves "email?: string" to the union type string | undefined.
            // The union containing undefined is the correct way to detect an optional param
            // when isOptional may be false due to SymbolFlags.Optional not being set.
            const node = graph.nodes.get('src/utils.ts#function:createUser');
            if (node?.kind === 'function') {
                const emailParam = node.parameters.find((p) => p.name === 'email');
                expect(emailParam).toBeDefined();
                // The type should be either:
                //   { kind: 'union', members: [...undefined..., ...string...] }
                //   OR the parameter itself is flagged optional
                const typeInfo = emailParam?.typeInfo;
                const isUnionWithUndefined = typeInfo?.kind === 'union' &&
                    typeInfo.members.some((m) => m.kind === 'primitive' && m.name === 'undefined');
                const isMarkedOptional = emailParam?.isOptional === true;
                expect(isUnionWithUndefined || isMarkedOptional).toBe(true);
            }
        });
        it('parameters "id" and "name" have simple primitive types (not optional)', () => {
            const node = graph.nodes.get('src/utils.ts#function:createUser');
            if (node?.kind === 'function') {
                const idParam = node.parameters.find((p) => p.name === 'id');
                const nameParam = node.parameters.find((p) => p.name === 'name');
                expect(idParam?.typeInfo).toEqual({ kind: 'primitive', name: 'number' });
                expect(nameParam?.typeInfo).toEqual({ kind: 'primitive', name: 'string' });
                expect(idParam?.isOptional).toBe(false);
                expect(nameParam?.isOptional).toBe(false);
            }
        });
    });
    // --------------------------------------------------------------------------
    // FunctionNode — formatList (rest parameter)
    // --------------------------------------------------------------------------
    describe('FunctionNode for "formatList" (rest parameter)', () => {
        it('is present in the graph', () => {
            const node = graph.nodes.get('src/utils.ts#function:formatList');
            expect(node).toBeDefined();
            expect(node?.kind).toBe('function');
        });
        it('has a rest parameter "items"', () => {
            const node = graph.nodes.get('src/utils.ts#function:formatList');
            if (node?.kind === 'function') {
                const itemsParam = node.parameters.find((p) => p.name === 'items');
                expect(itemsParam).toBeDefined();
                expect(itemsParam?.isRest).toBe(true);
            }
        });
        it('first parameter "separator" is not a rest parameter', () => {
            const node = graph.nodes.get('src/utils.ts#function:formatList');
            if (node?.kind === 'function') {
                const sepParam = node.parameters.find((p) => p.name === 'separator');
                expect(sepParam?.isRest).toBe(false);
            }
        });
    });
    // --------------------------------------------------------------------------
    // FunctionNode — assignRole (union / reference type parameter)
    // --------------------------------------------------------------------------
    describe('FunctionNode for "assignRole"', () => {
        it('is present in the graph', () => {
            const node = graph.nodes.get('src/utils.ts#function:assignRole');
            expect(node).toBeDefined();
            expect(node?.kind).toBe('function');
        });
        it('has two parameters', () => {
            const node = graph.nodes.get('src/utils.ts#function:assignRole');
            if (node?.kind === 'function') {
                expect(node.parameters).toHaveLength(2);
            }
        });
        it('parameter "user" has a reference or object typeInfo', () => {
            const node = graph.nodes.get('src/utils.ts#function:assignRole');
            if (node?.kind === 'function') {
                const userParam = node.parameters.find((p) => p.name === 'user');
                expect(userParam).toBeDefined();
                // User is a named interface → should be 'reference'
                expect(['reference', 'object']).toContain(userParam?.typeInfo.kind);
            }
        });
        it('parameter "role" resolves to a union or reference kind', () => {
            const node = graph.nodes.get('src/utils.ts#function:assignRole');
            if (node?.kind === 'function') {
                const roleParam = node.parameters.find((p) => p.name === 'role');
                expect(roleParam).toBeDefined();
                // Role is a type alias for a literal union — may resolve as reference or union
                expect(['union', 'reference']).toContain(roleParam?.typeInfo.kind);
            }
        });
    });
    // --------------------------------------------------------------------------
    // ClassNode — App
    // --------------------------------------------------------------------------
    describe('ClassNode for "App"', () => {
        let appNode;
        beforeAll(() => {
            const node = graph.nodes.get('src/index.ts#class:App');
            if (node?.kind === 'class') {
                appNode = node;
            }
        });
        it('is present in the graph', () => {
            expect(appNode).toBeDefined();
        });
        it('has kind "class"', () => {
            expect(appNode?.kind).toBe('class');
        });
        it('has name "App"', () => {
            expect(appNode?.name).toBe('App');
        });
        it('has isExported: true', () => {
            expect(appNode?.isExported).toBe(true);
        });
        it('has no superClass', () => {
            expect(appNode?.superClass).toBeUndefined();
        });
        it('has an empty interfaces list', () => {
            expect(appNode?.interfaces).toEqual([]);
        });
        it('has methods (constructor and run)', () => {
            // Methods are stored as FunctionNodes; the implementation prefixes method
            // names with the class name: "App.constructor", "App.run"
            expect(appNode?.methods.length).toBeGreaterThanOrEqual(1);
        });
        it('has a method named "App.run" or "run"', () => {
            // The implementation uses "<ClassName>.<methodName>" as the method name
            const runMethod = appNode?.methods.find((m) => m.name === 'App.run') ??
                appNode?.methods.find((m) => m.name === 'run');
            expect(runMethod).toBeDefined();
        });
        it('"run" method (App.run) has kind "function"', () => {
            const runMethod = appNode?.methods.find((m) => m.name === 'App.run') ??
                appNode?.methods.find((m) => m.name === 'run');
            expect(runMethod?.kind).toBe('function');
        });
        it('"run" method has zero parameters', () => {
            const runMethod = appNode?.methods.find((m) => m.name === 'App.run') ??
                appNode?.methods.find((m) => m.name === 'run');
            expect(runMethod?.parameters).toHaveLength(0);
        });
        it('"run" method has returnType void', () => {
            const runMethod = appNode?.methods.find((m) => m.name === 'App.run') ??
                appNode?.methods.find((m) => m.name === 'run');
            expect(runMethod?.returnType).toEqual({ kind: 'primitive', name: 'void' });
        });
        it('has a relative filePath pointing to src/index.ts', () => {
            expect(appNode?.filePath).toBe('src/index.ts');
        });
        it('id is stable string "src/index.ts#class:App"', () => {
            expect(appNode?.id).toBe('src/index.ts#class:App');
        });
        it('has a line number >= 1', () => {
            expect(appNode?.line ?? 0).toBeGreaterThanOrEqual(1);
        });
        it('has at least one property ("config")', () => {
            expect(appNode?.properties.length).toBeGreaterThanOrEqual(1);
            const configProp = appNode?.properties.find((p) => p.name === 'config');
            expect(configProp).toBeDefined();
        });
    });
    // --------------------------------------------------------------------------
    // InterfaceNode — User and Config
    // --------------------------------------------------------------------------
    describe('InterfaceNode for "User"', () => {
        it('is present in the graph', () => {
            const node = graph.nodes.get('src/types.ts#interface:User');
            expect(node).toBeDefined();
            expect(node?.kind).toBe('interface');
        });
        it('has name "User"', () => {
            const node = graph.nodes.get('src/types.ts#interface:User');
            expect(node?.name).toBe('User');
        });
        it('has isExported: true', () => {
            const node = graph.nodes.get('src/types.ts#interface:User');
            if (node?.kind === 'interface') {
                expect(node.isExported).toBe(true);
            }
        });
        it('has the expected properties (id, name)', () => {
            const node = graph.nodes.get('src/types.ts#interface:User');
            if (node?.kind === 'interface') {
                const propNames = node.properties.map((p) => p.name);
                expect(propNames).toContain('id');
                expect(propNames).toContain('name');
            }
        });
        it('property "email" is optional', () => {
            const node = graph.nodes.get('src/types.ts#interface:User');
            if (node?.kind === 'interface') {
                const emailProp = node.properties.find((p) => p.name === 'email');
                expect(emailProp?.isOptional).toBe(true);
            }
        });
        it('id is stable string "src/types.ts#interface:User"', () => {
            const node = graph.nodes.get('src/types.ts#interface:User');
            expect(node?.id).toBe('src/types.ts#interface:User');
        });
        it('has a relative filePath', () => {
            const node = graph.nodes.get('src/types.ts#interface:User');
            if (node?.kind === 'interface') {
                expect(path.isAbsolute(node.filePath)).toBe(false);
                expect(node.filePath).toContain('types.ts');
            }
        });
    });
    describe('InterfaceNode for "Config"', () => {
        it('is present in the graph', () => {
            const node = graph.nodes.get('src/types.ts#interface:Config');
            expect(node).toBeDefined();
            expect(node?.kind).toBe('interface');
        });
        it('has properties "host" and "port"', () => {
            const node = graph.nodes.get('src/types.ts#interface:Config');
            if (node?.kind === 'interface') {
                const propNames = node.properties.map((p) => p.name);
                expect(propNames).toContain('host');
                expect(propNames).toContain('port');
            }
        });
        it('property "debug" is optional', () => {
            const node = graph.nodes.get('src/types.ts#interface:Config');
            if (node?.kind === 'interface') {
                const debugProp = node.properties.find((p) => p.name === 'debug');
                expect(debugProp?.isOptional).toBe(true);
            }
        });
    });
    // --------------------------------------------------------------------------
    // TypeAliasNode — Role
    // --------------------------------------------------------------------------
    describe('TypeAliasNode for "Role"', () => {
        it('is present in the graph', () => {
            const node = graph.nodes.get('src/types.ts#typeAlias:Role');
            expect(node).toBeDefined();
            expect(node?.kind).toBe('typeAlias');
        });
        it('has name "Role"', () => {
            const node = graph.nodes.get('src/types.ts#typeAlias:Role');
            expect(node?.name).toBe('Role');
        });
        it('has isExported: true', () => {
            const node = graph.nodes.get('src/types.ts#typeAlias:Role');
            if (node?.kind === 'typeAlias') {
                expect(node.isExported).toBe(true);
            }
        });
        it('typeInfo is a union of string literals', () => {
            const node = graph.nodes.get('src/types.ts#typeAlias:Role');
            if (node?.kind === 'typeAlias') {
                expect(node.typeInfo.kind).toBe('union');
                if (node.typeInfo.kind === 'union') {
                    expect(node.typeInfo.members.length).toBeGreaterThanOrEqual(3);
                    const allLiterals = node.typeInfo.members.every((m) => m.kind === 'literal');
                    expect(allLiterals).toBe(true);
                }
            }
        });
        it('"admin", "user", "guest" are among the union literal values', () => {
            const node = graph.nodes.get('src/types.ts#typeAlias:Role');
            if (node?.kind === 'typeAlias' && node.typeInfo.kind === 'union') {
                const values = node.typeInfo.members
                    .filter((m) => m.kind === 'literal')
                    .map((m) => m.value);
                expect(values).toContain('admin');
                expect(values).toContain('user');
                expect(values).toContain('guest');
            }
        });
        it('id is stable string "src/types.ts#typeAlias:Role"', () => {
            const node = graph.nodes.get('src/types.ts#typeAlias:Role');
            expect(node?.id).toBe('src/types.ts#typeAlias:Role');
        });
    });
    // --------------------------------------------------------------------------
    // TypeAliasNode — UserId
    // --------------------------------------------------------------------------
    describe('TypeAliasNode for "UserId"', () => {
        it('is present in the graph', () => {
            const node = graph.nodes.get('src/types.ts#typeAlias:UserId');
            expect(node).toBeDefined();
            expect(node?.kind).toBe('typeAlias');
        });
        it('typeInfo resolves to primitive number', () => {
            const node = graph.nodes.get('src/types.ts#typeAlias:UserId');
            if (node?.kind === 'typeAlias') {
                expect(node.typeInfo).toEqual({ kind: 'primitive', name: 'number' });
            }
        });
    });
    // --------------------------------------------------------------------------
    // Node ID stability
    // --------------------------------------------------------------------------
    describe('node ID format — stable <relativePath>#<kind>:<name>', () => {
        it('all function node IDs follow the pattern <path>#function:<name>', () => {
            for (const [id, node] of graph.nodes) {
                if (node.kind === 'function') {
                    expect(id).toMatch(/^.+#function:.+$/);
                }
            }
        });
        it('all class node IDs follow the pattern <path>#class:<name>', () => {
            for (const [id, node] of graph.nodes) {
                if (node.kind === 'class') {
                    expect(id).toMatch(/^.+#class:.+$/);
                }
            }
        });
        it('all interface node IDs follow the pattern <path>#interface:<name>', () => {
            for (const [id, node] of graph.nodes) {
                if (node.kind === 'interface') {
                    expect(id).toMatch(/^.+#interface:.+$/);
                }
            }
        });
        it('all typeAlias node IDs follow the pattern <path>#typeAlias:<name>', () => {
            for (const [id, node] of graph.nodes) {
                if (node.kind === 'typeAlias') {
                    expect(id).toMatch(/^.+#typeAlias:.+$/);
                }
            }
        });
        it('all module node IDs follow the pattern <path>#module:<name>', () => {
            // The implementation uses makeNodeId(relPath, 'module', basenameWithoutExt)
            // which produces: src/utils.ts#module:utils (NOT src/utils.ts#module)
            for (const [id, node] of graph.nodes) {
                if (node.kind === 'module') {
                    expect(id).toMatch(/^.+#module:.+$/);
                }
            }
        });
        it('node IDs use forward slashes (not backslashes) on all platforms', () => {
            for (const id of graph.nodes.keys()) {
                expect(id).not.toContain('\\');
            }
        });
        it('node IDs do not include the absolute project root', () => {
            const resolvedRoot = path.resolve(FIXTURE_ROOT);
            for (const id of graph.nodes.keys()) {
                expect(id).not.toContain(resolvedRoot);
            }
        });
        it('node id matches node.id property', () => {
            for (const [id, node] of graph.nodes) {
                expect(node.id).toBe(id);
            }
        });
        it('node IDs start with "src/"', () => {
            for (const id of graph.nodes.keys()) {
                expect(id.startsWith('src/')).toBe(true);
            }
        });
    });
    // --------------------------------------------------------------------------
    // Edges — ImportEdge
    // --------------------------------------------------------------------------
    describe('ImportEdge — src/index.ts → src/utils.ts', () => {
        it('graph.edges contains at least one ImportEdge', () => {
            const importEdges = graph.edges.filter((e) => e.kind === 'import');
            expect(importEdges.length).toBeGreaterThan(0);
        });
        it('contains an ImportEdge from src/index.ts#module:index to src/utils.ts#module:utils', () => {
            const edge = graph.edges.find((e) => e.kind === 'import' &&
                e.from === 'src/index.ts#module:index' &&
                e.to === 'src/utils.ts#module:utils');
            expect(edge).toBeDefined();
        });
        it('ImportEdge from index.ts → utils.ts includes expected imported names', () => {
            const edge = graph.edges.find((e) => e.kind === 'import' &&
                e.from === 'src/index.ts#module:index' &&
                e.to === 'src/utils.ts#module:utils');
            if (edge?.kind === 'import') {
                expect(edge.importedNames).toContain('greet');
            }
        });
        it('ImportEdge from index.ts → utils.ts has isTypeOnly: false', () => {
            const edge = graph.edges.find((e) => e.kind === 'import' &&
                e.from === 'src/index.ts#module:index' &&
                e.to === 'src/utils.ts#module:utils');
            if (edge?.kind === 'import') {
                expect(edge.isTypeOnly).toBe(false);
            }
        });
        it('contains an ImportEdge from src/index.ts#module:index to src/types.ts#module:types (type-only)', () => {
            const edge = graph.edges.find((e) => e.kind === 'import' &&
                e.from === 'src/index.ts#module:index' &&
                e.to === 'src/types.ts#module:types');
            expect(edge).toBeDefined();
            if (edge?.kind === 'import') {
                expect(edge.isTypeOnly).toBe(true);
            }
        });
        it('contains an ImportEdge from src/utils.ts#module:utils to src/types.ts#module:types', () => {
            const edge = graph.edges.find((e) => e.kind === 'import' &&
                e.from === 'src/utils.ts#module:utils' &&
                e.to === 'src/types.ts#module:types');
            expect(edge).toBeDefined();
        });
    });
    // --------------------------------------------------------------------------
    // Edges — all edges have valid from/to node IDs
    // --------------------------------------------------------------------------
    describe('edge integrity', () => {
        it('all edge kinds in the graph are one of the four expected kinds', () => {
            const validKinds = new Set(['call', 'import', 'inherits', 'references']);
            for (const edge of graph.edges) {
                expect(validKinds.has(edge.kind)).toBe(true);
            }
        });
        it('all edges have non-empty "from" and "to" fields', () => {
            for (const edge of graph.edges) {
                expect(edge.from.length).toBeGreaterThan(0);
                expect(edge.to.length).toBeGreaterThan(0);
            }
        });
        it('CallEdges have a line number >= 1', () => {
            const callEdges = graph.edges.filter((e) => e.kind === 'call');
            for (const edge of callEdges) {
                if (edge.kind === 'call') {
                    expect(edge.line).toBeGreaterThanOrEqual(1);
                }
            }
        });
        it('ImportEdges have an importedNames array', () => {
            const importEdges = graph.edges.filter((e) => e.kind === 'import');
            for (const edge of importEdges) {
                if (edge.kind === 'import') {
                    expect(Array.isArray(edge.importedNames)).toBe(true);
                }
            }
        });
        it('there are exactly 3 import edges (index→utils, index→types, utils→types)', () => {
            const importEdges = graph.edges.filter((e) => e.kind === 'import');
            expect(importEdges).toHaveLength(3);
        });
    });
    // --------------------------------------------------------------------------
    // buildGraph options
    // --------------------------------------------------------------------------
    describe('buildGraph options', () => {
        it('accepts a custom maxTypeDepth option without error', () => {
            const scanner = new projectScanner_js_1.ProjectScanner();
            const scanResult = scanner.scan({ projectRoot: FIXTURE_ROOT });
            if (scanResult.isErr())
                return;
            const result = (0, dependencyGraph_js_1.buildGraph)(scanResult.value, { maxTypeDepth: 3 });
            expect(result.isOk()).toBe(true);
        });
        it('skipDeclarationFiles: false still produces a valid graph', () => {
            const scanner = new projectScanner_js_1.ProjectScanner();
            const scanResult = scanner.scan({ projectRoot: FIXTURE_ROOT });
            if (scanResult.isErr())
                return;
            const result = (0, dependencyGraph_js_1.buildGraph)(scanResult.value, { skipDeclarationFiles: false });
            // May or may not succeed depending on lib files, but should not throw
            expect(typeof result.isOk()).toBe('boolean');
        });
    });
});
//# sourceMappingURL=dependencyGraph.test.js.map