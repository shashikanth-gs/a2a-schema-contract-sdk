import type { AnySchema, ValidateFunction } from 'ajv/dist/2020.js';

import type { ContractCatalog } from '../core/catalog.js';
import type { JsonValue } from '../core/constants.js';
import { type ErrorContext, fail } from '../core/errors.js';
import { isRecord } from '../core/json.js';
import { compileSchema, schemaValidator } from '../core/schema.js';

export interface SchemaProgram {
  readonly entry: string;
  readonly documents: readonly { readonly uri: string; readonly value: JsonValue }[];
}
export interface CatalogProgram {
  readonly contracts: ContractCatalog['contracts'];
  readonly schemas?: Readonly<Record<string, SchemaProgram>>;
}
const programs = new WeakMap<object, CatalogProgram>();
export function catalogProgram(catalog: ContractCatalog): CatalogProgram {
  return programs.get(catalog) ?? { contracts: catalog.contracts };
}
export function registerProgram(catalog: ContractCatalog, program: CatalogProgram): void {
  programs.set(catalog, program);
}
export function compileProgram(program: SchemaProgram, context: ErrorContext): ValidateFunction {
  const ajv = schemaValidator();
  try {
    for (const document of program.documents)
      ajv.addSchema(document.value as AnySchema, document.uri);
    // Ajv's reference scanner skips a document's root anchors. Register their
    // native identities explicitly without changing the acquired schema bytes.
    const anchors = new Set<string>();
    for (const document of program.documents) {
      const value = document.value;
      if (!isRecord(value)) continue;
      const base = new URL(typeof value.$id === 'string' ? value.$id : document.uri, document.uri);
      for (const keyword of ['$anchor', '$dynamicAnchor']) {
        if (typeof value[keyword] !== 'string') continue;
        const alias = new URL('#' + value[keyword], base).href;
        if (anchors.has(alias)) continue;
        ajv.addSchema(value, alias);
        anchors.add(alias);
      }
    }
    return ajv.compile({ $ref: program.entry });
  } catch {
    return fail('SCHEMA_INVALID', context);
  }
}
export function catalogCompiler(program: CatalogProgram) {
  const cache = new Map<string, ValidateFunction>();
  return (descriptor: import('../core/catalog.js').SchemaDescriptor, context: ErrorContext) => {
    const key = JSON.stringify([context.contractId, context.direction, context.representationId]);
    const existing = cache.get(key);
    if (existing) return existing;
    let validate: ValidateFunction;
    if (descriptor.bundle) return fail('SCHEMA_UNAVAILABLE', context);
    if (descriptor.dialect !== 'https://json-schema.org/draft/2020-12/schema')
      return fail('UNSUPPORTED_DIALECT', context);
    if (descriptor.mediaType !== 'application/schema+json')
      return fail('UNSUPPORTED_MEDIA_TYPE', context);
    const resolved = program.schemas?.[key];
    if (resolved) validate = compileProgram(resolved, context);
    else if (Object.hasOwn(descriptor, 'inline'))
      validate = compileSchema(descriptor.inline!, context);
    else return fail('SCHEMA_UNAVAILABLE', context);
    cache.set(key, validate);
    return validate;
  };
}
