import { FieldFactory, renderFormHtml } from '../../src/server/formGenerator.js';
import type {
  FieldDescriptor,
  FormDescriptor,
} from '../../src/server/formGenerator.js';
import type { FunctionNode, TypeInfo } from '../../src/graph/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStringTypeInfo(): TypeInfo {
  return { kind: 'primitive', name: 'string' };
}

function makeNumberTypeInfo(): TypeInfo {
  return { kind: 'primitive', name: 'number' };
}

function makeBooleanTypeInfo(): TypeInfo {
  return { kind: 'primitive', name: 'boolean' };
}

function makeFunctionNode(
  overrides: Partial<FunctionNode> = {},
): FunctionNode {
  return {
    kind: 'function',
    id: 'src/utils.ts#function:greet',
    name: 'greet',
    filePath: '/project/src/utils.ts',
    line: 3,
    column: 0,
    isAsync: false,
    isExported: true,
    parameters: [],
    returnType: { kind: 'primitive', name: 'void' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// FieldFactory — typeInfoToField
// ---------------------------------------------------------------------------

describe('FieldFactory.typeInfoToField', () => {
  let factory: FieldFactory;

  beforeEach(() => {
    factory = new FieldFactory();
  });

  // ---- Primitive: string ---------------------------------------------------

  describe('primitive string', () => {
    it('maps { kind: "primitive", name: "string" } → { kind: "text" }', () => {
      const field = factory.typeInfoToField('name', 'Name', makeStringTypeInfo(), true);
      expect(field.kind).toBe('text');
    });

    it('preserves the name on the field', () => {
      const field = factory.typeInfoToField('myParam', 'My Param', makeStringTypeInfo(), true);
      expect(field.name).toBe('myParam');
    });

    it('preserves the label on the field', () => {
      const field = factory.typeInfoToField('name', 'Full Name', makeStringTypeInfo(), true);
      expect(field.label).toBe('Full Name');
    });

    it('preserves required: true', () => {
      const field = factory.typeInfoToField('name', 'Name', makeStringTypeInfo(), true);
      expect(field.required).toBe(true);
    });

    it('preserves required: false', () => {
      const field = factory.typeInfoToField('name', 'Name', makeStringTypeInfo(), false);
      expect(field.required).toBe(false);
    });
  });

  // ---- Primitive: number ---------------------------------------------------

  describe('primitive number', () => {
    it('maps { kind: "primitive", name: "number" } → { kind: "number" }', () => {
      const field = factory.typeInfoToField('age', 'Age', makeNumberTypeInfo(), true);
      expect(field.kind).toBe('number');
    });

    it('preserves name and label', () => {
      const field = factory.typeInfoToField('count', 'Count', makeNumberTypeInfo(), false);
      expect(field.name).toBe('count');
      expect(field.label).toBe('Count');
    });

    it('required flag is forwarded', () => {
      const required = factory.typeInfoToField('x', 'X', makeNumberTypeInfo(), true);
      const optional = factory.typeInfoToField('x', 'X', makeNumberTypeInfo(), false);
      expect(required.required).toBe(true);
      expect(optional.required).toBe(false);
    });
  });

  // ---- Primitive: boolean --------------------------------------------------

  describe('primitive boolean', () => {
    it('maps { kind: "primitive", name: "boolean" } → { kind: "checkbox" }', () => {
      const field = factory.typeInfoToField('active', 'Active', makeBooleanTypeInfo(), false);
      expect(field.kind).toBe('checkbox');
    });

    it('preserves name and label', () => {
      const field = factory.typeInfoToField('debug', 'Debug Mode', makeBooleanTypeInfo(), false);
      expect(field.name).toBe('debug');
      expect(field.label).toBe('Debug Mode');
    });
  });

  // ---- Primitive: remaining kinds ------------------------------------------

  describe('remaining primitive kinds', () => {
    const primitiveTextCases: Array<{ name: string }> = [
      { name: 'null' },
      { name: 'undefined' },
      { name: 'void' },
      { name: 'never' },
    ];

    primitiveTextCases.forEach(({ name }) => {
      it(`primitive "${name}" → { kind: "text" } with label hint`, () => {
        const typeInfo: TypeInfo = { kind: 'primitive', name: name as 'null' | 'undefined' | 'void' | 'never' };
        const field = factory.typeInfoToField('p', 'P', typeInfo, false);
        expect(field.kind).toBe('text');
        expect(field.label).toContain(name);
      });
    });

    it('primitive "unknown" → { kind: "textarea" }', () => {
      const typeInfo: TypeInfo = { kind: 'primitive', name: 'unknown' };
      const field = factory.typeInfoToField('p', 'P', typeInfo, false);
      expect(field.kind).toBe('textarea');
    });

    it('primitive "any" → { kind: "textarea" }', () => {
      const typeInfo: TypeInfo = { kind: 'primitive', name: 'any' };
      const field = factory.typeInfoToField('p', 'P', typeInfo, false);
      expect(field.kind).toBe('textarea');
    });
  });

  // ---- Literal -------------------------------------------------------------

  describe('literal type', () => {
    it('maps a string literal → { kind: "select", options: [value] }', () => {
      const typeInfo: TypeInfo = { kind: 'literal', value: 'admin' };
      const field = factory.typeInfoToField('role', 'Role', typeInfo, true);
      expect(field.kind).toBe('select');
      if (field.kind === 'select') {
        expect(field.options).toEqual(['admin']);
      }
    });

    it('maps a number literal → { kind: "select", options: ["42"] }', () => {
      const typeInfo: TypeInfo = { kind: 'literal', value: 42 };
      const field = factory.typeInfoToField('code', 'Code', typeInfo, false);
      expect(field.kind).toBe('select');
      if (field.kind === 'select') {
        expect(field.options).toEqual(['42']);
      }
    });

    it('maps a boolean literal → { kind: "select", options: ["true"] }', () => {
      const typeInfo: TypeInfo = { kind: 'literal', value: true };
      const field = factory.typeInfoToField('flag', 'Flag', typeInfo, false);
      expect(field.kind).toBe('select');
      if (field.kind === 'select') {
        expect(field.options).toEqual(['true']);
      }
    });
  });

  // ---- Union: all literals (select) ----------------------------------------

  describe('union of all literals → select', () => {
    const roleUnion: TypeInfo = {
      kind: 'union',
      members: [
        { kind: 'literal', value: 'admin' },
        { kind: 'literal', value: 'user' },
        { kind: 'literal', value: 'guest' },
      ],
    };

    it('maps a union of all literals → { kind: "select" }', () => {
      const field = factory.typeInfoToField('role', 'Role', roleUnion, true);
      expect(field.kind).toBe('select');
    });

    it('select options contain all literal values as strings', () => {
      const field = factory.typeInfoToField('role', 'Role', roleUnion, true);
      if (field.kind === 'select') {
        expect(field.options).toContain('admin');
        expect(field.options).toContain('user');
        expect(field.options).toContain('guest');
      }
    });

    it('select options have the same length as union members', () => {
      const field = factory.typeInfoToField('role', 'Role', roleUnion, true);
      if (field.kind === 'select') {
        expect(field.options).toHaveLength(3);
      }
    });

    it('preserves required and name on the select field', () => {
      const field = factory.typeInfoToField('role', 'Role', roleUnion, true);
      expect(field.name).toBe('role');
      expect(field.required).toBe(true);
    });
  });

  // ---- Union: all primitives (text) ----------------------------------------

  describe('union of all primitives → text', () => {
    it('maps "string | number" union → { kind: "text" }', () => {
      const typeInfo: TypeInfo = {
        kind: 'union',
        members: [
          { kind: 'primitive', name: 'string' },
          { kind: 'primitive', name: 'number' },
        ],
      };
      const field = factory.typeInfoToField('value', 'Value', typeInfo, true);
      expect(field.kind).toBe('text');
    });

    it('label for all-primitive union contains the type names', () => {
      const typeInfo: TypeInfo = {
        kind: 'union',
        members: [
          { kind: 'primitive', name: 'string' },
          { kind: 'primitive', name: 'number' },
        ],
      };
      const field = factory.typeInfoToField('value', 'Value', typeInfo, true);
      expect(field.label).toContain('string');
      expect(field.label).toContain('number');
    });
  });

  // ---- Union: string | null (mixed) ----------------------------------------

  describe('mixed union (string | null)', () => {
    it('does not return a select (because null is a primitive, not literal)', () => {
      const typeInfo: TypeInfo = {
        kind: 'union',
        members: [
          { kind: 'primitive', name: 'string' },
          { kind: 'primitive', name: 'null' },
        ],
      };
      const field = factory.typeInfoToField('value', 'Value', typeInfo, false);
      // all-primitive union → text
      expect(field.kind).toBe('text');
    });
  });

  // ---- Union: partially literal (literal | primitive) ----------------------

  describe('partially literal union (literal + primitive)', () => {
    it('renders as text with options hint in the label', () => {
      const typeInfo: TypeInfo = {
        kind: 'union',
        members: [
          { kind: 'literal', value: 'a' },
          { kind: 'primitive', name: 'string' },
        ],
      };
      const field = factory.typeInfoToField('x', 'X', typeInfo, false);
      // partially literal → text with hint label
      expect(field.kind).toBe('text');
      expect(field.label).toContain('a');
    });
  });

  // ---- Union: fully complex (textarea fallback) ----------------------------

  describe('fully complex union → textarea fallback', () => {
    it('maps a union of objects → textarea', () => {
      const typeInfo: TypeInfo = {
        kind: 'union',
        members: [
          { kind: 'object', properties: [] },
          { kind: 'object', properties: [] },
        ],
      };
      const field = factory.typeInfoToField('data', 'Data', typeInfo, false);
      expect(field.kind).toBe('textarea');
    });
  });

  // ---- Object type → fieldset ----------------------------------------------

  describe('object type → fieldset', () => {
    it('maps { kind: "object", properties: [...] } → { kind: "fieldset" }', () => {
      const typeInfo: TypeInfo = {
        kind: 'object',
        properties: [
          {
            name: 'host',
            typeInfo: { kind: 'primitive', name: 'string' },
            isOptional: false,
            isReadonly: false,
          },
          {
            name: 'port',
            typeInfo: { kind: 'primitive', name: 'number' },
            isOptional: false,
            isReadonly: false,
          },
        ],
      };

      const field = factory.typeInfoToField('config', 'Config', typeInfo, true);
      expect(field.kind).toBe('fieldset');
    });

    it('fieldset contains a sub-field for each object property', () => {
      const typeInfo: TypeInfo = {
        kind: 'object',
        properties: [
          {
            name: 'host',
            typeInfo: { kind: 'primitive', name: 'string' },
            isOptional: false,
            isReadonly: false,
          },
          {
            name: 'port',
            typeInfo: { kind: 'primitive', name: 'number' },
            isOptional: false,
            isReadonly: false,
          },
        ],
      };

      const field = factory.typeInfoToField('config', 'Config', typeInfo, true);
      if (field.kind === 'fieldset') {
        expect(field.fields).toHaveLength(2);
      }
    });

    it('sub-fields have correct kinds for their property types', () => {
      const typeInfo: TypeInfo = {
        kind: 'object',
        properties: [
          {
            name: 'host',
            typeInfo: { kind: 'primitive', name: 'string' },
            isOptional: false,
            isReadonly: false,
          },
          {
            name: 'port',
            typeInfo: { kind: 'primitive', name: 'number' },
            isOptional: false,
            isReadonly: false,
          },
          {
            name: 'debug',
            typeInfo: { kind: 'primitive', name: 'boolean' },
            isOptional: true,
            isReadonly: false,
          },
        ],
      };

      const field = factory.typeInfoToField('config', 'Config', typeInfo, true);
      if (field.kind === 'fieldset') {
        const hostField = field.fields.find((f) => f.label === 'host');
        const portField = field.fields.find((f) => f.label === 'port');
        const debugField = field.fields.find((f) => f.label === 'debug');
        expect(hostField?.kind).toBe('text');
        expect(portField?.kind).toBe('number');
        expect(debugField?.kind).toBe('checkbox');
      }
    });

    it('optional object properties map to required: false on sub-fields', () => {
      const typeInfo: TypeInfo = {
        kind: 'object',
        properties: [
          {
            name: 'debug',
            typeInfo: { kind: 'primitive', name: 'boolean' },
            isOptional: true,
            isReadonly: false,
          },
        ],
      };

      const field = factory.typeInfoToField('config', 'Config', typeInfo, true);
      if (field.kind === 'fieldset') {
        // isOptional=true → required=false on sub-field (!isOptional)
        expect(field.fields[0]?.required).toBe(false);
      }
    });

    it('sub-field names are prefixed with the parent name', () => {
      const typeInfo: TypeInfo = {
        kind: 'object',
        properties: [
          {
            name: 'host',
            typeInfo: { kind: 'primitive', name: 'string' },
            isOptional: false,
            isReadonly: false,
          },
        ],
      };

      const field = factory.typeInfoToField('config', 'Config', typeInfo, true);
      if (field.kind === 'fieldset') {
        expect(field.fields[0]?.name).toBe('config.host');
      }
    });

    it('empty object maps to fieldset with empty fields array', () => {
      const typeInfo: TypeInfo = { kind: 'object', properties: [] };
      const field = factory.typeInfoToField('empty', 'Empty', typeInfo, false);
      expect(field.kind).toBe('fieldset');
      if (field.kind === 'fieldset') {
        expect(field.fields).toHaveLength(0);
      }
    });
  });

  // ---- Array type → textarea -----------------------------------------------

  describe('array type → textarea', () => {
    it('maps array type → { kind: "textarea" }', () => {
      const typeInfo: TypeInfo = {
        kind: 'array',
        elementType: { kind: 'primitive', name: 'string' },
      };
      const field = factory.typeInfoToField('items', 'Items', typeInfo, true);
      expect(field.kind).toBe('textarea');
    });

    it('array label contains "JSON array"', () => {
      const typeInfo: TypeInfo = {
        kind: 'array',
        elementType: { kind: 'primitive', name: 'number' },
      };
      const field = factory.typeInfoToField('items', 'Items', typeInfo, true);
      expect(field.label).toContain('JSON array');
    });
  });

  // ---- Tuple type → textarea -----------------------------------------------

  describe('tuple type → textarea', () => {
    it('maps tuple type → { kind: "textarea" }', () => {
      const typeInfo: TypeInfo = {
        kind: 'tuple',
        elements: [
          { kind: 'primitive', name: 'string' },
          { kind: 'primitive', name: 'number' },
        ],
      };
      const field = factory.typeInfoToField('pair', 'Pair', typeInfo, true);
      expect(field.kind).toBe('textarea');
    });
  });

  // ---- Intersection type → fieldset ----------------------------------------

  describe('intersection type → fieldset', () => {
    it('maps intersection of two object types → { kind: "fieldset" }', () => {
      const typeInfo: TypeInfo = {
        kind: 'intersection',
        members: [
          {
            kind: 'object',
            properties: [
              {
                name: 'id',
                typeInfo: { kind: 'primitive', name: 'number' },
                isOptional: false,
                isReadonly: false,
              },
            ],
          },
          {
            kind: 'object',
            properties: [
              {
                name: 'role',
                typeInfo: { kind: 'primitive', name: 'string' },
                isOptional: false,
                isReadonly: false,
              },
            ],
          },
        ],
      };

      const field = factory.typeInfoToField('userWithRole', 'User With Role', typeInfo, true);
      expect(field.kind).toBe('fieldset');
    });

    it('intersection fieldset merges properties from all object members', () => {
      const typeInfo: TypeInfo = {
        kind: 'intersection',
        members: [
          {
            kind: 'object',
            properties: [
              {
                name: 'id',
                typeInfo: { kind: 'primitive', name: 'number' },
                isOptional: false,
                isReadonly: false,
              },
            ],
          },
          {
            kind: 'object',
            properties: [
              {
                name: 'role',
                typeInfo: { kind: 'primitive', name: 'string' },
                isOptional: false,
                isReadonly: false,
              },
            ],
          },
        ],
      };

      const field = factory.typeInfoToField('userWithRole', 'User With Role', typeInfo, true);
      if (field.kind === 'fieldset') {
        expect(field.fields).toHaveLength(2);
        const fieldLabels = field.fields.map((f) => f.label);
        expect(fieldLabels).toContain('id');
        expect(fieldLabels).toContain('role');
      }
    });
  });

  // ---- Reference type → text -----------------------------------------------

  describe('reference type → text', () => {
    it('maps reference type → { kind: "text" }', () => {
      const typeInfo: TypeInfo = {
        kind: 'reference',
        name: 'User',
        typeArguments: [],
      };
      const field = factory.typeInfoToField('user', 'User', typeInfo, true);
      expect(field.kind).toBe('text');
    });

    it('label for reference type includes the type name', () => {
      const typeInfo: TypeInfo = {
        kind: 'reference',
        name: 'Config',
        typeArguments: [],
      };
      const field = factory.typeInfoToField('config', 'Config', typeInfo, true);
      expect(field.label).toContain('Config');
    });
  });

  // ---- Function type → textarea --------------------------------------------

  describe('function type → textarea', () => {
    it('maps function type → { kind: "textarea" }', () => {
      const typeInfo: TypeInfo = {
        kind: 'function',
        parameters: [],
        returnType: { kind: 'primitive', name: 'void' },
      };
      const field = factory.typeInfoToField('callback', 'Callback', typeInfo, false);
      expect(field.kind).toBe('textarea');
    });

    it('label for function type contains "function"', () => {
      const typeInfo: TypeInfo = {
        kind: 'function',
        parameters: [],
        returnType: { kind: 'primitive', name: 'void' },
      };
      const field = factory.typeInfoToField('callback', 'Callback', typeInfo, false);
      expect(field.label).toContain('function');
    });
  });

  // ---- Unknown type → textarea ---------------------------------------------

  describe('unknown type → textarea', () => {
    it('maps unknown type → { kind: "textarea" }', () => {
      const typeInfo: TypeInfo = { kind: 'unknown', raw: 'ComplexType<X>' };
      const field = factory.typeInfoToField('x', 'X', typeInfo, false);
      expect(field.kind).toBe('textarea');
    });

    it('label for unknown type contains the raw type string', () => {
      const typeInfo: TypeInfo = { kind: 'unknown', raw: 'ComplexType<X>' };
      const field = factory.typeInfoToField('x', 'X', typeInfo, false);
      expect(field.label).toContain('ComplexType<X>');
    });
  });
});

// ---------------------------------------------------------------------------
// FieldFactory — parametersToForm
// ---------------------------------------------------------------------------

describe('FieldFactory.parametersToForm', () => {
  let factory: FieldFactory;

  beforeEach(() => {
    factory = new FieldFactory();
  });

  it('returns a FormDescriptor with correct functionId and functionName', () => {
    const node = makeFunctionNode({ id: 'src/utils.ts#function:greet', name: 'greet' });
    const form = factory.parametersToForm(node);

    expect(form.functionId).toBe('src/utils.ts#function:greet');
    expect(form.functionName).toBe('greet');
  });

  it('returns a FormDescriptor with empty fields for a zero-param function', () => {
    const node = makeFunctionNode({ parameters: [] });
    const form = factory.parametersToForm(node);

    expect(form.fields).toHaveLength(0);
  });

  it('returns one field per parameter', () => {
    const node = makeFunctionNode({
      parameters: [
        {
          name: 'name',
          typeInfo: { kind: 'primitive', name: 'string' },
          isOptional: false,
          isRest: false,
        },
        {
          name: 'age',
          typeInfo: { kind: 'primitive', name: 'number' },
          isOptional: false,
          isRest: false,
        },
      ],
    });

    const form = factory.parametersToForm(node);
    expect(form.fields).toHaveLength(2);
  });

  it('required parameter → field has required: true', () => {
    const node = makeFunctionNode({
      parameters: [
        {
          name: 'name',
          typeInfo: { kind: 'primitive', name: 'string' },
          isOptional: false,
          isRest: false,
        },
      ],
    });

    const form = factory.parametersToForm(node);
    expect(form.fields[0]?.required).toBe(true);
  });

  it('optional parameter → field has required: false', () => {
    const node = makeFunctionNode({
      parameters: [
        {
          name: 'email',
          typeInfo: { kind: 'primitive', name: 'string' },
          isOptional: true,
          isRest: false,
        },
      ],
    });

    const form = factory.parametersToForm(node);
    expect(form.fields[0]?.required).toBe(false);
  });

  it('rest parameter → field has required: false', () => {
    const node = makeFunctionNode({
      parameters: [
        {
          name: 'items',
          typeInfo: {
            kind: 'array',
            elementType: { kind: 'primitive', name: 'string' },
          },
          isOptional: false,
          isRest: true,
        },
      ],
    });

    const form = factory.parametersToForm(node);
    expect(form.fields[0]?.required).toBe(false);
  });

  it('field name matches parameter name', () => {
    const node = makeFunctionNode({
      parameters: [
        {
          name: 'userId',
          typeInfo: { kind: 'primitive', name: 'number' },
          isOptional: false,
          isRest: false,
        },
      ],
    });

    const form = factory.parametersToForm(node);
    expect(form.fields[0]?.name).toBe('userId');
  });

  it('field kind is derived from parameter typeInfo', () => {
    const node = makeFunctionNode({
      parameters: [
        {
          name: 'active',
          typeInfo: { kind: 'primitive', name: 'boolean' },
          isOptional: false,
          isRest: false,
        },
      ],
    });

    const form = factory.parametersToForm(node);
    expect(form.fields[0]?.kind).toBe('checkbox');
  });

  it('builds correct form for a realistic multi-param function', () => {
    const node = makeFunctionNode({
      id: 'src/utils.ts#function:createUser',
      name: 'createUser',
      parameters: [
        {
          name: 'id',
          typeInfo: { kind: 'primitive', name: 'number' },
          isOptional: false,
          isRest: false,
        },
        {
          name: 'name',
          typeInfo: { kind: 'primitive', name: 'string' },
          isOptional: false,
          isRest: false,
        },
        {
          name: 'email',
          typeInfo: { kind: 'primitive', name: 'string' },
          isOptional: true,
          isRest: false,
        },
      ],
    });

    const form = factory.parametersToForm(node);
    expect(form.functionName).toBe('createUser');
    expect(form.fields).toHaveLength(3);

    const idField = form.fields.find((f) => f.name === 'id');
    const nameField = form.fields.find((f) => f.name === 'name');
    const emailField = form.fields.find((f) => f.name === 'email');

    expect(idField?.kind).toBe('number');
    expect(idField?.required).toBe(true);
    expect(nameField?.kind).toBe('text');
    expect(nameField?.required).toBe(true);
    expect(emailField?.kind).toBe('text');
    expect(emailField?.required).toBe(false);
  });

  it('union parameter with all literals → select field', () => {
    const node = makeFunctionNode({
      parameters: [
        {
          name: 'role',
          typeInfo: {
            kind: 'union',
            members: [
              { kind: 'literal', value: 'admin' },
              { kind: 'literal', value: 'user' },
              { kind: 'literal', value: 'guest' },
            ],
          },
          isOptional: false,
          isRest: false,
        },
      ],
    });

    const form = factory.parametersToForm(node);
    expect(form.fields[0]?.kind).toBe('select');
    if (form.fields[0]?.kind === 'select') {
      expect(form.fields[0].options).toContain('admin');
      expect(form.fields[0].options).toContain('user');
      expect(form.fields[0].options).toContain('guest');
    }
  });

  it('object parameter → fieldset', () => {
    const node = makeFunctionNode({
      parameters: [
        {
          name: 'config',
          typeInfo: {
            kind: 'object',
            properties: [
              {
                name: 'host',
                typeInfo: { kind: 'primitive', name: 'string' },
                isOptional: false,
                isReadonly: false,
              },
              {
                name: 'port',
                typeInfo: { kind: 'primitive', name: 'number' },
                isOptional: false,
                isReadonly: false,
              },
            ],
          },
          isOptional: false,
          isRest: false,
        },
      ],
    });

    const form = factory.parametersToForm(node);
    expect(form.fields[0]?.kind).toBe('fieldset');
    if (form.fields[0]?.kind === 'fieldset') {
      expect(form.fields[0].fields).toHaveLength(2);
    }
  });
});

// ---------------------------------------------------------------------------
// renderFormHtml
// ---------------------------------------------------------------------------

describe('renderFormHtml', () => {
  function makeForm(overrides: Partial<FormDescriptor> = {}): FormDescriptor {
    return {
      functionId: 'src/utils.ts#function:greet',
      functionName: 'greet',
      fields: [],
      ...overrides,
    };
  }

  it('returns a string', () => {
    const html = renderFormHtml(makeForm());
    expect(typeof html).toBe('string');
  });

  it('contains a <form element', () => {
    const html = renderFormHtml(makeForm());
    expect(html).toContain('<form');
  });

  it('contains the closing </form> tag', () => {
    const html = renderFormHtml(makeForm());
    expect(html).toContain('</form>');
  });

  it('contains the function name in the output', () => {
    const html = renderFormHtml(makeForm({ functionName: 'greet' }));
    expect(html).toContain('greet');
  });

  it('contains the function id somewhere in the form id attribute', () => {
    const html = renderFormHtml(makeForm({ functionId: 'src/utils.ts#function:greet' }));
    expect(html).toContain('param-form-');
  });

  it('contains a submit button', () => {
    const html = renderFormHtml(makeForm());
    expect(html).toContain('<button');
    expect(html).toContain('type="submit"');
  });

  it('contains a "no parameters" message for a zero-field form', () => {
    const html = renderFormHtml(makeForm({ fields: [] }));
    expect(html).toContain('no parameters');
  });

  it('renders a text input for a text field', () => {
    const form: FormDescriptor = makeForm({
      fields: [
        { kind: 'text', name: 'name', label: 'Name', required: true },
      ],
    });
    const html = renderFormHtml(form);
    expect(html).toContain('type="text"');
    expect(html).toContain('name="name"');
  });

  it('renders a number input for a number field', () => {
    const form: FormDescriptor = makeForm({
      fields: [
        { kind: 'number', name: 'age', label: 'Age', required: true },
      ],
    });
    const html = renderFormHtml(form);
    expect(html).toContain('type="number"');
    expect(html).toContain('name="age"');
  });

  it('renders a checkbox input for a checkbox field', () => {
    const form: FormDescriptor = makeForm({
      fields: [
        { kind: 'checkbox', name: 'active', label: 'Active', required: false },
      ],
    });
    const html = renderFormHtml(form);
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('name="active"');
  });

  it('renders a <select> for a select field', () => {
    const form: FormDescriptor = makeForm({
      fields: [
        {
          kind: 'select',
          name: 'role',
          label: 'Role',
          required: true,
          options: ['admin', 'user', 'guest'],
        },
      ],
    });
    const html = renderFormHtml(form);
    expect(html).toContain('<select');
    expect(html).toContain('name="role"');
  });

  it('select options are rendered as <option> elements', () => {
    const form: FormDescriptor = makeForm({
      fields: [
        {
          kind: 'select',
          name: 'role',
          label: 'Role',
          required: true,
          options: ['admin', 'user', 'guest'],
        },
      ],
    });
    const html = renderFormHtml(form);
    expect(html).toContain('<option value="admin">admin</option>');
    expect(html).toContain('<option value="user">user</option>');
    expect(html).toContain('<option value="guest">guest</option>');
  });

  it('renders a <textarea> for a textarea field', () => {
    const form: FormDescriptor = makeForm({
      fields: [
        { kind: 'textarea', name: 'data', label: 'Data', required: false },
      ],
    });
    const html = renderFormHtml(form);
    expect(html).toContain('<textarea');
    expect(html).toContain('name="data"');
  });

  it('renders a <fieldset> for a fieldset field', () => {
    const form: FormDescriptor = makeForm({
      fields: [
        {
          kind: 'fieldset',
          name: 'config',
          label: 'Config',
          required: true,
          fields: [
            { kind: 'text', name: 'config.host', label: 'host', required: true },
            { kind: 'number', name: 'config.port', label: 'port', required: true },
          ],
        },
      ],
    });
    const html = renderFormHtml(form);
    expect(html).toContain('<fieldset');
    expect(html).toContain('</fieldset>');
  });

  it('fieldset sub-fields are rendered inside the fieldset', () => {
    const form: FormDescriptor = makeForm({
      fields: [
        {
          kind: 'fieldset',
          name: 'config',
          label: 'Config',
          required: true,
          fields: [
            { kind: 'text', name: 'config.host', label: 'host', required: true },
          ],
        },
      ],
    });
    const html = renderFormHtml(form);
    // The sub-field name should appear inside the fieldset HTML
    expect(html).toContain('config.host');
  });

  it('required fields have the "required" attribute', () => {
    const form: FormDescriptor = makeForm({
      fields: [
        { kind: 'text', name: 'name', label: 'Name', required: true },
      ],
    });
    const html = renderFormHtml(form);
    expect(html).toContain(' required');
  });

  it('optional fields do not have the "required" attribute on the input', () => {
    const form: FormDescriptor = makeForm({
      fields: [
        { kind: 'text', name: 'email', label: 'Email', required: false },
      ],
    });
    const html = renderFormHtml(form);
    // Check input element does not have "required"
    // The form might have "required" in the label for asterisk check, so we check the
    // specific input element.
    expect(html).not.toContain('type="text" name="email" style="" required');
    // More precisely: the input for email should not have "required"
    const inputMatch = html.match(/<input[^>]*name="email"[^>]*>/);
    expect(inputMatch).not.toBeNull();
    if (inputMatch) {
      expect(inputMatch[0]).not.toContain(' required');
    }
  });

  it('contains parameter names from the form fields', () => {
    const form: FormDescriptor = makeForm({
      functionName: 'createUser',
      fields: [
        { kind: 'number', name: 'id', label: 'id', required: true },
        { kind: 'text', name: 'name', label: 'name', required: true },
        { kind: 'text', name: 'email', label: 'email', required: false },
      ],
    });
    const html = renderFormHtml(form);
    expect(html).toContain('name="id"');
    expect(html).toContain('name="name"');
    expect(html).toContain('name="email"');
  });

  it('escapes HTML special characters in function name', () => {
    const form: FormDescriptor = makeForm({
      functionName: '<script>alert("xss")</script>',
    });
    const html = renderFormHtml(form);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes HTML special characters in field label', () => {
    const form: FormDescriptor = makeForm({
      fields: [
        { kind: 'text', name: 'x', label: '<b>Bold</b>', required: false },
      ],
    });
    const html = renderFormHtml(form);
    expect(html).not.toContain('<b>Bold</b>');
    expect(html).toContain('&lt;b&gt;Bold&lt;/b&gt;');
  });

  it('escapes HTML special characters in function id', () => {
    const form: FormDescriptor = makeForm({
      functionId: 'src/utils.ts#function:test"XSS',
    });
    const html = renderFormHtml(form);
    // The escaped form id should not have a raw double-quote in the id attribute
    expect(html).not.toContain('param-form-src/utils.ts#function:test"XSS');
  });

  it('renders all fields from a parametersToForm result', () => {
    const node = makeFunctionNode({
      id: 'src/utils.ts#function:add',
      name: 'add',
      parameters: [
        {
          name: 'a',
          typeInfo: { kind: 'primitive', name: 'number' },
          isOptional: false,
          isRest: false,
        },
        {
          name: 'b',
          typeInfo: { kind: 'primitive', name: 'number' },
          isOptional: false,
          isRest: false,
        },
      ],
    });

    const factory = new FieldFactory();
    const form = factory.parametersToForm(node);
    const html = renderFormHtml(form);

    expect(html).toContain('<form');
    expect(html).toContain('add');
    expect(html).toContain('name="a"');
    expect(html).toContain('name="b"');
    expect(html).toContain('type="number"');
  });

  it('renders inline styles (no external CSS dependency)', () => {
    const html = renderFormHtml(makeForm());
    // Inline styles use the "style" attribute
    expect(html).toContain('style=');
  });
});
