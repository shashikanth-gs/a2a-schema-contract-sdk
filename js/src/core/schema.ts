import { Ajv2020, MissingRefError, type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js';
import { JSON_SCHEMA_DIALECT, type JsonValue } from './constants.js';
import { fail, type ErrorContext } from './errors.js';
import { absoluteUri, isRecord, LIMITS } from './json.js';

const vocabularies = new Set(
  [
    'core',
    'applicator',
    'validation',
    'unevaluated',
    'meta-data',
    'format-annotation',
    'content',
  ].map((name) => `https://json-schema.org/draft/2020-12/vocab/${name}`),
);
const mapSchemas = new Set(['$defs', 'properties', 'patternProperties', 'dependentSchemas']);
const oneSchema = new Set([
  'additionalProperties',
  'unevaluatedProperties',
  'propertyNames',
  'items',
  'contains',
  'unevaluatedItems',
  'not',
  'if',
  'then',
  'else',
  'contentSchema',
]);
const arraySchemas = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const keywords = new Set([
  '$schema',
  '$id',
  '$anchor',
  '$dynamicAnchor',
  '$ref',
  '$dynamicRef',
  '$comment',
  '$vocabulary',
  'type',
  'enum',
  'const',
  'multipleOf',
  'maximum',
  'minimum',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'maxLength',
  'minLength',
  'pattern',
  'maxItems',
  'minItems',
  'uniqueItems',
  'maxContains',
  'minContains',
  'maxProperties',
  'minProperties',
  'required',
  'dependentRequired',
  'title',
  'description',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
  'examples',
  'format',
  'contentEncoding',
  'contentMediaType',
  ...mapSchemas,
  ...oneSchema,
  ...arraySchemas,
]);

/** Small portable regex grammar; at most one variable repetition avoids nested/overlapping work. */
function checkPattern(pattern: string, context: ErrorContext): void {
  if (pattern.length > LIMITS.pattern || /[^\x20-\x7e]/u.test(pattern))
    fail('UNSUPPORTED_REGEX', context);
  let variable = 0;
  let atom = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '^' || char === '$') {
      if (char === '^' ? i !== 0 : i !== pattern.length - 1) fail('UNSUPPORTED_REGEX', context);
      atom = false;
    } else if (char === '[') {
      const end = pattern.indexOf(']', i + 1);
      const body = pattern.slice(i + 1, end);
      if (end === -1 || body === '' || body === '^' || /[[\\]/u.test(body))
        fail('UNSUPPORTED_REGEX', context);
      i = end;
      atom = true;
    } else if (char === '\\') {
      if (!/[.[\]{}()*+?^$|\\-]/u.test(pattern[i + 1] ?? '')) fail('UNSUPPORTED_REGEX', context);
      i++;
      atom = true;
    } else if ('?*+{'.includes(char)) {
      if (!atom) fail('UNSUPPORTED_REGEX', context);
      if (char === '{') {
        const bound = /^\{([0-9]+)(?:,([0-9]*))?\}/u.exec(pattern.slice(i));
        if (
          !bound ||
          Number(bound[1]) > LIMITS.string ||
          (bound[2] !== undefined &&
            bound[2] !== '' &&
            (Number(bound[2]) < Number(bound[1]) || Number(bound[2]) > LIMITS.string))
        )
          fail('UNSUPPORTED_REGEX', context);
        if (bound[2] !== undefined && bound[2] !== bound[1]) variable++;
        i += bound[0].length - 1;
      } else {
        variable++;
      }
      if (variable > 1) fail('UNSUPPORTED_REGEX', context);
      atom = false;
    } else {
      if ('().|]}'.includes(char)) fail('UNSUPPORTED_REGEX', context);
      atom = true;
    }
  }
  try {
    new RegExp(pattern, 'u');
  } catch {
    fail('UNSUPPORTED_REGEX', context);
  }
}

/** Compile a private schema snapshot with no external loader or mutating options. */
export function compileSchema(schema: JsonValue, context: ErrorContext): ValidateFunction {
  let count = 0;
  let refs = 0;
  function visit(node: JsonValue): void {
    if (++count > LIMITS.schemas) fail('RESOURCE_LIMIT', context);
    if (typeof node === 'boolean') return;
    if (!isRecord(node)) fail('SCHEMA_INVALID', context);
    if (node.$schema !== undefined && node.$schema !== JSON_SCHEMA_DIALECT)
      fail('UNSUPPORTED_DIALECT', context);
    if (
      node.$id !== undefined &&
      (typeof node.$id !== 'string' || /\s|%(?![0-9A-Fa-f]{2})/u.test(node.$id))
    )
      fail('SCHEMA_INVALID', context);
    if (node.$vocabulary !== undefined) {
      if (!isRecord(node.$vocabulary)) fail('SCHEMA_INVALID', context);
      for (const [uri, required] of Object.entries(node.$vocabulary)) {
        if (typeof required !== 'boolean' || !absoluteUri(uri)) fail('SCHEMA_INVALID', context);
        if ((vocabularies.has(uri) && !required) || (!vocabularies.has(uri) && required))
          fail('UNSUPPORTED_VOCABULARY', context);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (!keywords.has(key)) fail('UNSUPPORTED_KEYWORD', context);
      if (key === 'pattern' && typeof value === 'string') checkPattern(value, context);
      if (
        key === 'multipleOf' &&
        (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
      )
        fail('UNSUPPORTED_NUMBER', context);
      if (key === '$ref' || key === '$dynamicRef') {
        if (++refs > LIMITS.references) fail('RESOURCE_LIMIT', context);
        if (key === '$dynamicRef' && typeof value === 'string' && !value.startsWith('#'))
          fail('SCHEMA_UNAVAILABLE', context);
        // A direct root self-reference cannot make instance progress.
        if (
          node === schema &&
          value === '#' &&
          Object.keys(node).every((name) => name.startsWith('$'))
        )
          fail('SCHEMA_INVALID', context);
      }
      if (mapSchemas.has(key)) {
        if (!isRecord(value)) fail('SCHEMA_INVALID', context);
        // Ajv excludes this exact map key; never silently drop an advertised constraint.
        if (
          (key === 'properties' || key === 'patternProperties') &&
          Object.hasOwn(value, '__proto__')
        )
          fail('UNSUPPORTED_KEYWORD', context);
        for (const [name, child] of Object.entries(value)) {
          if (key === 'patternProperties') checkPattern(name, context);
          visit(child);
        }
      }
      if (oneSchema.has(key)) visit(value);
      if (arraySchemas.has(key)) {
        if (!Array.isArray(value)) fail('SCHEMA_INVALID', context);
        for (const child of value as readonly JsonValue[]) visit(child);
      }
    }
  }
  visit(schema);
  // strictTypes/strictTuples are authoring lint, not JSON Schema validity requirements.
  const ajv = new Ajv2020({
    strictSchema: false,
    strictTypes: false,
    strictTuples: false,
    strictRequired: false,
    validateFormats: false,
    allErrors: false,
    logger: false,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    ownProperties: true,
    inlineRefs: false,
    loopRequired: 32,
    loopEnum: 32,
  });
  try {
    return ajv.compile(schema as AnySchema);
  } catch (error) {
    return fail(
      error instanceof MissingRefError ? 'SCHEMA_UNAVAILABLE' : 'SCHEMA_INVALID',
      context,
    );
  }
}

export function checkInstance(
  validate: ValidateFunction,
  value: JsonValue,
  context: ErrorContext,
): void {
  let valid: boolean;
  try {
    valid = validate(value);
  } catch {
    return fail('RESOURCE_LIMIT', context);
  }
  if (!valid) fail('INSTANCE_INVALID', context);
}
