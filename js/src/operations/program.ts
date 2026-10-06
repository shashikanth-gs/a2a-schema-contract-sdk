import type { AnySchema, ValidateFunction } from 'ajv/dist/2020.js';
import type { ContractCatalog } from '../core/catalog.js';
import { compileSchema, schemaValidator } from '../core/schema.js';
import { fail, type ErrorContext } from '../core/errors.js';
import type { JsonValue } from '../core/constants.js';

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
