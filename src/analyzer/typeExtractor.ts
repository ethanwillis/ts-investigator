import ts from 'typescript';
import type { TypeInfo, ParameterInfo, PropertyInfo } from '../graph/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_DEPTH = 5;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns the JSDoc comment text attached to a symbol, or undefined if absent.
 */
function getJsDocComment(symbol: ts.Symbol, checker: ts.TypeChecker): string | undefined {
  const parts = symbol.getDocumentationComment(checker);
  if (parts.length === 0) return undefined;
  const text = ts.displayPartsToString(parts).trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Returns true when a symbol has the Optional flag (i.e. `foo?: T`).
 * Also returns true when the parameter has a default value initializer.
 */
function isSymbolOptional(symbol: ts.Symbol): boolean {
  if ((symbol.getFlags() & ts.SymbolFlags.Optional) !== 0) return true;
  const decl = symbol.declarations?.[0];
  if (decl !== undefined && ts.isParameter(decl)) {
    return decl.initializer !== undefined;
  }
  return false;
}

/**
 * Returns true when a parameter symbol has a `...` rest token.
 */
function isSymbolRest(symbol: ts.Symbol): boolean {
  const decl = symbol.declarations?.[0];
  if (decl === undefined) return false;
  if (!ts.isParameter(decl)) return false;
  return decl.dotDotDotToken !== undefined;
}

/**
 * Returns the source text of a parameter's default value initializer, or
 * undefined if none exists.
 */
function getParameterDefaultValue(symbol: ts.Symbol): string | undefined {
  const decl = symbol.declarations?.[0];
  if (decl === undefined) return undefined;
  if (!ts.isParameter(decl)) return undefined;
  if (decl.initializer === undefined) return undefined;
  return decl.initializer.getText();
}

/**
 * Returns true when a property symbol is readonly (either via `readonly`
 * modifier or via membership in a `readonly` interface/tuple element).
 */
function isSymbolReadonly(symbol: ts.Symbol): boolean {
  const decl = symbol.declarations?.[0];
  if (decl === undefined) return false;
  if (ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl)) {
    return (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Readonly) !== 0;
  }
  return false;
}

// ---------------------------------------------------------------------------
// TypeExtractor
// ---------------------------------------------------------------------------

export class TypeExtractor {
  // -------------------------------------------------------------------------
  // extractTypeInfo
  // -------------------------------------------------------------------------

  /**
   * Maps a `ts.Type` to the serializable `TypeInfo` discriminated union.
   *
   * @param type    The TypeScript compiler type to inspect.
   * @param checker The type-checker associated with the current program.
   * @param depth   Recursion guard; defaults to 0. Returns `unknown` at ≥ MAX_DEPTH.
   */
  extractTypeInfo(type: ts.Type, checker: ts.TypeChecker, depth = 0): TypeInfo {
    if (depth >= MAX_DEPTH) {
      return { kind: 'unknown', raw: checker.typeToString(type) };
    }

    const flags = type.getFlags();

    // ----- Top-level intrinsics: any / unknown / never / void ---------------
    // Checked first so they short-circuit before the broader Object flag.
    if ((flags & ts.TypeFlags.Any) !== 0) return { kind: 'primitive', name: 'any' };
    if ((flags & ts.TypeFlags.Unknown) !== 0) return { kind: 'primitive', name: 'unknown' };
    if ((flags & ts.TypeFlags.Never) !== 0) return { kind: 'primitive', name: 'never' };
    if ((flags & ts.TypeFlags.Void) !== 0) return { kind: 'primitive', name: 'void' };

    // ----- Null / Undefined -------------------------------------------------
    if ((flags & ts.TypeFlags.Null) !== 0) return { kind: 'primitive', name: 'null' };
    if ((flags & ts.TypeFlags.Undefined) !== 0) return { kind: 'primitive', name: 'undefined' };

    // ----- Primitive widened types ------------------------------------------
    // Check Boolean before BooleanLiteral because TypeFlags.Boolean is 1 << 4
    // and TypeFlags.BooleanLiteral is 1 << 16 — they do not overlap.
    if ((flags & ts.TypeFlags.String) !== 0) return { kind: 'primitive', name: 'string' };
    if ((flags & ts.TypeFlags.Number) !== 0) return { kind: 'primitive', name: 'number' };
    if ((flags & ts.TypeFlags.Boolean) !== 0) return { kind: 'primitive', name: 'boolean' };

    // ----- Literal types ----------------------------------------------------
    if ((flags & ts.TypeFlags.StringLiteral) !== 0) {
      return { kind: 'literal', value: (type as ts.StringLiteralType).value };
    }
    if ((flags & ts.TypeFlags.NumberLiteral) !== 0) {
      return { kind: 'literal', value: (type as ts.NumberLiteralType).value };
    }
    if ((flags & ts.TypeFlags.BooleanLiteral) !== 0) {
      // BooleanLiteral types do not expose `.value` in the public API.
      // `typeToString` reliably returns 'true' or 'false'.
      return { kind: 'literal', value: checker.typeToString(type) === 'true' };
    }

    // ----- Type parameters (generics: T, K, V, …) ---------------------------
    if ((flags & ts.TypeFlags.TypeParameter) !== 0) {
      // ts.Type.symbol is typed as non-optional in the public API but can be
      // absent at runtime for synthetic types — cast defensively.
      const typeSym = type.symbol as ts.Symbol | undefined;
      const name =
        typeSym !== undefined ? checker.symbolToString(typeSym) : checker.typeToString(type);
      return { kind: 'reference', name, typeArguments: [] };
    }

    // ----- Union / Intersection ---------------------------------------------
    // Checked after primitives/literals so that `boolean` (union of true|false
    // in the checker internals) is caught by TypeFlags.Boolean above first.
    if (type.isUnion()) {
      const members = type.types.map((t) => this.extractTypeInfo(t, checker, depth + 1));
      return { kind: 'union', members };
    }
    if (type.isIntersection()) {
      const members = type.types.map((t) => this.extractTypeInfo(t, checker, depth + 1));
      return { kind: 'intersection', members };
    }

    // ----- Object types (Array, Tuple, Function, Reference, plain Object) ---
    if ((flags & ts.TypeFlags.Object) !== 0) {
      return this.#extractObjectType(type as ts.ObjectType, checker, depth);
    }

    // ----- Fallthrough ------------------------------------------------------
    return { kind: 'unknown', raw: checker.typeToString(type) };
  }

  // -------------------------------------------------------------------------
  // extractParameters
  // -------------------------------------------------------------------------

  /**
   * Extracts the full `ParameterInfo` list from a call/construct signature.
   *
   * @param signature The compiler signature to extract from.
   * @param checker   The type-checker associated with the current program.
   * @param depth     Recursion depth forwarded to `extractTypeInfo`.
   */
  extractParameters(
    signature: ts.Signature,
    checker: ts.TypeChecker,
    depth = 0,
  ): readonly ParameterInfo[] {
    return signature.getParameters().map((paramSymbol): ParameterInfo => {
      const paramType = checker.getTypeOfSymbol(paramSymbol);
      const typeInfo = this.extractTypeInfo(paramType, checker, depth);
      const isOptional = isSymbolOptional(paramSymbol);
      const isRest = isSymbolRest(paramSymbol);
      const defaultValue = getParameterDefaultValue(paramSymbol);

      // Use spread to comply with exactOptionalPropertyTypes — omit the key
      // entirely rather than setting it to `undefined`.
      return {
        name: paramSymbol.getName(),
        typeInfo,
        isOptional,
        isRest,
        ...(defaultValue !== undefined ? { defaultValue } : {}),
      };
    });
  }

  // -------------------------------------------------------------------------
  // extractPropertyInfo
  // -------------------------------------------------------------------------

  /**
   * Extracts `PropertyInfo` from a property symbol.
   *
   * @param symbol  A property symbol returned by `checker.getPropertiesOfType`.
   * @param checker The type-checker associated with the current program.
   * @param depth   Recursion depth forwarded to `extractTypeInfo`.
   */
  extractPropertyInfo(symbol: ts.Symbol, checker: ts.TypeChecker, depth = 0): PropertyInfo {
    const propType = checker.getTypeOfSymbol(symbol);
    const typeInfo = this.extractTypeInfo(propType, checker, depth);
    const isOptional = isSymbolOptional(symbol);
    const isReadonly = isSymbolReadonly(symbol);
    const jsdoc = getJsDocComment(symbol, checker);

    return {
      name: symbol.getName(),
      typeInfo,
      isOptional,
      isReadonly,
      ...(jsdoc !== undefined ? { jsdoc } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Handles all `ts.TypeFlags.Object` cases: Array, Tuple, function,
   * TypeReference (generic instantiation), named class/interface, and
   * anonymous object types.
   */
  #extractObjectType(type: ts.ObjectType, checker: ts.TypeChecker, depth: number): TypeInfo {
    // ---- Array — must precede tuple since ReadonlyArray is also a reference --
    if (checker.isArrayType(type)) {
      const typeRef = type as ts.TypeReference;
      const typeArgs = checker.getTypeArguments(typeRef);
      const elementType: TypeInfo =
        typeArgs[0] !== undefined
          ? this.extractTypeInfo(typeArgs[0], checker, depth + 1)
          : { kind: 'unknown', raw: 'unknown' };
      return { kind: 'array', elementType };
    }

    // ---- Tuple -------------------------------------------------------------
    if (checker.isTupleType(type)) {
      const typeRef = type as ts.TypeReference;
      const typeArgs = checker.getTypeArguments(typeRef);
      const elements = typeArgs.map((t) => this.extractTypeInfo(t, checker, depth + 1));
      return { kind: 'tuple', elements };
    }

    // ---- Function (object type with call signatures) -----------------------
    const callSignatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
    if (callSignatures.length > 0) {
      const sig = callSignatures[0]!; // safe: length > 0
      const parameters = this.extractParameters(sig, checker, depth + 1);
      const returnTypeTs = checker.getReturnTypeOfSignature(sig);
      const returnType = this.extractTypeInfo(returnTypeTs, checker, depth + 1);
      return { kind: 'function', parameters, returnType };
    }

    const objFlags = type.objectFlags;

    // ---- Generic instantiation (TypeReference) — e.g. Map<string, number> -
    if ((objFlags & ts.ObjectFlags.Reference) !== 0) {
      const typeRef = type as ts.TypeReference;
      // `target.symbol` and `type.symbol` are typed non-optional in the public
      // API but can be absent at runtime — cast defensively.
      const targetSym = typeRef.target.symbol as ts.Symbol | undefined;
      const typeSym = type.symbol as ts.Symbol | undefined;
      const sym = targetSym ?? typeSym;
      if (sym !== undefined) {
        const name = checker.symbolToString(sym);
        const typeArgs = checker.getTypeArguments(typeRef);
        const typeArguments = typeArgs.map((t) => this.extractTypeInfo(t, checker, depth + 1));
        return { kind: 'reference', name, typeArguments };
      }
    }

    // ---- Named class / interface type --------------------------------------
    const objTypeSym = type.symbol as ts.Symbol | undefined;
    if (objTypeSym !== undefined) {
      const symFlags = objTypeSym.getFlags();
      const isClass = (symFlags & ts.SymbolFlags.Class) !== 0;
      const isInterface = (symFlags & ts.SymbolFlags.Interface) !== 0;
      const isTypeAlias = (symFlags & ts.SymbolFlags.TypeAlias) !== 0;
      const isEnum = (symFlags & ts.SymbolFlags.Enum) !== 0;
      const isNamed = isClass || isInterface || isTypeAlias || isEnum;

      if (isNamed) {
        const name = checker.symbolToString(objTypeSym);
        return { kind: 'reference', name, typeArguments: [] };
      }
    }

    // ---- Anonymous / mapped / conditional object — extract properties ------
    const properties = checker
      .getPropertiesOfType(type)
      .map((sym) => this.extractPropertyInfo(sym, checker, depth + 1));
    return { kind: 'object', properties };
  }
}

// ---------------------------------------------------------------------------
// Standalone exports (convenience wrappers around a shared default instance)
// ---------------------------------------------------------------------------

const _defaultExtractor = new TypeExtractor();

/**
 * Extracts parameter metadata from a call/construct signature.
 * Convenience wrapper around `TypeExtractor.extractParameters`.
 */
export function extractParameters(
  signature: ts.Signature,
  checker: ts.TypeChecker,
): readonly ParameterInfo[] {
  return _defaultExtractor.extractParameters(signature, checker);
}

/**
 * Extracts property metadata from a symbol returned by `getPropertiesOfType`.
 * Convenience wrapper around `TypeExtractor.extractPropertyInfo`.
 */
export function extractPropertyInfo(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  depth?: number,
): PropertyInfo {
  return _defaultExtractor.extractPropertyInfo(symbol, checker, depth);
}
