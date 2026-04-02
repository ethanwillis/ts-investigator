import type { TypeInfo, PropertyInfo, FunctionNode } from '../graph/types.js';

// ---------------------------------------------------------------------------
// Field Descriptor types
// ---------------------------------------------------------------------------

export type FieldDescriptor =
  | { kind: 'text'; name: string; label: string; required: boolean }
  | { kind: 'number'; name: string; label: string; required: boolean }
  | { kind: 'checkbox'; name: string; label: string; required: boolean }
  | { kind: 'select'; name: string; label: string; required: boolean; options: readonly string[] }
  | { kind: 'textarea'; name: string; label: string; required: boolean }
  | {
      kind: 'fieldset';
      name: string;
      label: string;
      required: boolean;
      fields: readonly FieldDescriptor[];
    };

// ---------------------------------------------------------------------------
// Form Descriptor
// ---------------------------------------------------------------------------

export interface FormDescriptor {
  readonly functionId: string;
  readonly functionName: string;
  readonly fields: readonly FieldDescriptor[];
}

// ---------------------------------------------------------------------------
// FieldFactory — maps TypeInfo variants to FieldDescriptor (Factory Pattern)
// ---------------------------------------------------------------------------

export class FieldFactory {
  /**
   * Maps a single TypeInfo to a FieldDescriptor.
   * Handles all TypeInfo variants with appropriate UI representation.
   */
  typeInfoToField(
    name: string,
    label: string,
    typeInfo: TypeInfo,
    required: boolean,
  ): FieldDescriptor {
    switch (typeInfo.kind) {
      case 'primitive':
        return this._primitiveToField(name, label, typeInfo.name as string, required);

      case 'literal':
        return {
          kind: 'select',
          name,
          label,
          required,
          options: [String(typeInfo.value)],
        };

      case 'union':
        return this._unionToField(name, label, typeInfo.members, required);

      case 'array':
        return {
          kind: 'textarea',
          name,
          label: `${label} (JSON array)`,
          required,
        };

      case 'tuple':
        return {
          kind: 'textarea',
          name,
          label: `${label} (JSON tuple array)`,
          required,
        };

      case 'object': {
        const fields: FieldDescriptor[] = typeInfo.properties.map((prop: PropertyInfo) =>
          this.typeInfoToField(`${name}.${prop.name}`, prop.name, prop.typeInfo, !prop.isOptional),
        );
        return { kind: 'fieldset', name, label, required, fields };
      }

      case 'intersection': {
        // Merge all object properties from intersection members into a single fieldset
        const fields: FieldDescriptor[] = [];
        for (const member of typeInfo.members) {
          if (member.kind === 'object') {
            for (const prop of member.properties) {
              fields.push(
                this.typeInfoToField(
                  `${name}.${prop.name}`,
                  prop.name,
                  prop.typeInfo,
                  !prop.isOptional,
                ),
              );
            }
          } else {
            // Non-object intersection member — render as a sub-field with type hint
            fields.push(
              this.typeInfoToField(
                `${name}._part${fields.length}`,
                `${label} (part ${fields.length + 1})`,
                member,
                required,
              ),
            );
          }
        }
        return { kind: 'fieldset', name, label, required, fields };
      }

      case 'reference':
        return {
          kind: 'text',
          name,
          label: `${label} (${typeInfo.name} — enter JSON)`,
          required,
        };

      case 'function':
        return {
          kind: 'textarea',
          name,
          label: `${label} (function — enter JSON or arrow expression)`,
          required,
        };

      case 'unknown':
        return {
          kind: 'textarea',
          name,
          label: `${label} (${typeInfo.raw} — enter JSON)`,
          required,
        };
    }
  }

  /**
   * Builds a `FormDescriptor` from a `FunctionNode` by mapping each parameter
   * to a field descriptor.
   */
  parametersToForm(functionNode: FunctionNode): FormDescriptor {
    const fields: FieldDescriptor[] = functionNode.parameters.map((param) =>
      this.typeInfoToField(
        param.name,
        param.name,
        param.typeInfo,
        !param.isOptional && !param.isRest,
      ),
    );

    return {
      functionId: functionNode.id,
      functionName: functionNode.name,
      fields,
    };
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private _primitiveToField(
    name: string,
    label: string,
    primitiveName: string,
    required: boolean,
  ): FieldDescriptor {
    switch (primitiveName) {
      case 'string':
        return { kind: 'text', name, label, required };
      case 'number':
        return { kind: 'number', name, label, required };
      case 'boolean':
        return { kind: 'checkbox', name, label, required };
      case 'null':
        return { kind: 'text', name, label: `${label} (null)`, required };
      case 'undefined':
        return { kind: 'text', name, label: `${label} (undefined)`, required };
      case 'void':
        return { kind: 'text', name, label: `${label} (void)`, required };
      case 'never':
        return { kind: 'text', name, label: `${label} (never)`, required };
      case 'unknown':
      case 'any':
      default:
        return { kind: 'textarea', name, label: `${label} (any — enter JSON)`, required };
    }
  }

  private _unionToField(
    name: string,
    label: string,
    members: readonly TypeInfo[],
    required: boolean,
  ): FieldDescriptor {
    // If ALL members are literals → select with one option per literal value
    const allLiterals = members.every((m) => m.kind === 'literal');
    if (allLiterals) {
      const options = members.map((m) => String((m as TypeInfo & { kind: 'literal' }).value));
      return { kind: 'select', name, label, required, options };
    }

    // If ALL members are primitives → plain text (accepts any of the primitive types)
    const allPrimitives = members.every((m) => m.kind === 'primitive');
    if (allPrimitives) {
      const typeNames = members
        .map((m) => (m as TypeInfo & { kind: 'primitive' }).name)
        .join(' | ');
      return { kind: 'text', name, label: `${label} (${typeNames})`, required };
    }

    // Mixed union (e.g. string | null, literal | primitive, complex type | null)
    // Collect unique option strings for any literal members to hint the user
    const literalOptions = members
      .filter((m): m is TypeInfo & { kind: 'literal' } => m.kind === 'literal')
      .map((m) => String(m.value));

    if (literalOptions.length > 0 && literalOptions.length < members.length) {
      // Partially literal union: offer the literal values as suggestions but
      // keep it as a text field so non-literal branches can be entered freely
      const primitiveNames = members
        .filter((m) => m.kind === 'primitive')
        .map((m) => (m as TypeInfo & { kind: 'primitive' }).name);

      const allHints = [...literalOptions, ...primitiveNames];
      return {
        kind: 'text',
        name,
        label: `${label} (one of: ${allHints.join(', ')})`,
        required,
      };
    }

    // Fully complex union — fall back to textarea for arbitrary JSON
    return {
      kind: 'textarea',
      name,
      label: `${label} (union — enter JSON)`,
      required,
    };
  }
}

// ---------------------------------------------------------------------------
// HTML rendering helpers
// ---------------------------------------------------------------------------

/** Escapes a string for safe insertion into HTML text content or attribute values. */
function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Returns the inline CSS for label elements. */
function labelStyle(): string {
  return (
    'display:block;margin-bottom:4px;font-size:12px;font-weight:600;' +
    'color:#a0aec0;text-transform:uppercase;letter-spacing:0.05em;'
  );
}

/** Returns the inline CSS for text/number inputs. */
function inputStyle(): string {
  return (
    'width:100%;box-sizing:border-box;padding:8px 10px;border-radius:6px;' +
    'border:1px solid #4a4a6a;background:#1e1e3a;color:#e2e8f0;' +
    'font-size:13px;outline:none;transition:border-color 0.2s;'
  );
}

/** Returns the inline CSS for textarea elements. */
function textareaStyle(): string {
  return inputStyle() + 'font-family:monospace;resize:vertical;min-height:80px;';
}

/** Returns the inline CSS for select elements. */
function selectStyle(): string {
  return inputStyle() + 'appearance:none;cursor:pointer;';
}

/** Returns the inline CSS for a field wrapper div. */
function fieldWrapStyle(): string {
  return 'margin-bottom:14px;';
}

/** Renders a single `FieldDescriptor` to an HTML string. */
function renderField(field: FieldDescriptor, depth = 0): string {
  const escapedName = escapeHtml(field.name);
  const escapedLabel = escapeHtml(field.label);
  const requiredAttr = field.required ? ' required' : '';
  const indent = depth > 0 ? `margin-left:${depth * 12}px;` : '';

  switch (field.kind) {
    case 'text':
      return (
        `<div style="${fieldWrapStyle()}${indent}">` +
        `<label style="${labelStyle()}" for="${escapedName}">${escapedLabel}${field.required ? ' <span style="color:#fc8181">*</span>' : ''}</label>` +
        `<input id="${escapedName}" type="text" name="${escapedName}" style="${inputStyle()}"${requiredAttr} />` +
        `</div>`
      );

    case 'number':
      return (
        `<div style="${fieldWrapStyle()}${indent}">` +
        `<label style="${labelStyle()}" for="${escapedName}">${escapedLabel}${field.required ? ' <span style="color:#fc8181">*</span>' : ''}</label>` +
        `<input id="${escapedName}" type="number" name="${escapedName}" style="${inputStyle()}"${requiredAttr} />` +
        `</div>`
      );

    case 'checkbox':
      return (
        `<div style="${fieldWrapStyle()}${indent}display:flex;align-items:center;gap:8px;">` +
        `<input id="${escapedName}" type="checkbox" name="${escapedName}" style="width:16px;height:16px;cursor:pointer;" />` +
        `<label style="font-size:13px;color:#e2e8f0;cursor:pointer;" for="${escapedName}">${escapedLabel}</label>` +
        `</div>`
      );

    case 'select': {
      const optionsHtml = field.options
        .map((opt) => `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`)
        .join('');
      return (
        `<div style="${fieldWrapStyle()}${indent}">` +
        `<label style="${labelStyle()}" for="${escapedName}">${escapedLabel}${field.required ? ' <span style="color:#fc8181">*</span>' : ''}</label>` +
        `<select id="${escapedName}" name="${escapedName}" style="${selectStyle()}"${requiredAttr}>` +
        `<option value="">-- select --</option>` +
        optionsHtml +
        `</select>` +
        `</div>`
      );
    }

    case 'textarea':
      return (
        `<div style="${fieldWrapStyle()}${indent}">` +
        `<label style="${labelStyle()}" for="${escapedName}">${escapedLabel}${field.required ? ' <span style="color:#fc8181">*</span>' : ''}</label>` +
        `<textarea id="${escapedName}" name="${escapedName}" style="${textareaStyle()}" rows="4"${requiredAttr}></textarea>` +
        `</div>`
      );

    case 'fieldset': {
      const fieldsHtml = field.fields.map((f) => renderField(f, depth + 1)).join('');
      return (
        `<fieldset style="${fieldWrapStyle()}${indent}border:1px solid #4a4a6a;border-radius:6px;padding:12px;margin:0 0 14px 0;">` +
        `<legend style="color:#a0aec0;font-size:12px;font-weight:600;padding:0 6px;text-transform:uppercase;letter-spacing:0.05em;">${escapedLabel}</legend>` +
        fieldsHtml +
        `</fieldset>`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produces a complete HTML `<form>` string for the given `FormDescriptor`.
 * The form is self-contained with inline styles (no external CSS or JS deps).
 */
export function renderFormHtml(form: FormDescriptor): string {
  const escapedId = escapeHtml(form.functionId);
  const escapedName = escapeHtml(form.functionName);

  const fieldsHtml =
    form.fields.length > 0
      ? form.fields.map((f) => renderField(f, 0)).join('')
      : `<p style="color:#718096;font-size:13px;font-style:italic;">This function takes no parameters.</p>`;

  const formStyle =
    'font-family:Helvetica,Arial,sans-serif;background:#16163a;color:#e2e8f0;' +
    'padding:0;margin:0;';

  const headerStyle = 'padding:14px 16px 10px;border-bottom:1px solid #2d2d5a;margin-bottom:16px;';

  const titleStyle =
    'font-size:15px;font-weight:700;color:#818cf8;margin:0 0 2px;white-space:nowrap;' +
    'overflow:hidden;text-overflow:ellipsis;';

  const subtitleStyle = 'font-size:11px;color:#64748b;margin:0;';

  const bodyStyle = 'padding:0 16px 8px;';

  const submitStyle =
    'width:100%;padding:10px;border-radius:6px;border:none;cursor:pointer;' +
    'background:linear-gradient(135deg,#818cf8,#6366f1);color:#ffffff;' +
    'font-size:14px;font-weight:600;letter-spacing:0.03em;' +
    'transition:opacity 0.2s;margin-top:4px;';

  return (
    `<form id="param-form-${escapedId}" style="${formStyle}" onsubmit="return false;">` +
    `<div style="${headerStyle}">` +
    `<p style="${titleStyle}">${escapedName}()</p>` +
    `<p style="${subtitleStyle}">ID: ${escapedId}</p>` +
    `</div>` +
    `<div style="${bodyStyle}">` +
    fieldsHtml +
    `<button type="submit" style="${submitStyle}">Invoke</button>` +
    `</div>` +
    `</form>`
  );
}
