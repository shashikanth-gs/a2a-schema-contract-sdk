import type { ValidateFunction } from 'ajv/dist/2020.js';
import {
  JSON_SCHEMA_DIALECT,
  EXTENSION_URI,
  type Direction,
  type JsonValue,
  type Presence,
} from './constants.js';
import { ContractError, fail, type DiagnosticCode, type ErrorContext } from './errors.js';
import { isRecord, snapshot, versionedId } from './json.js';
import { media, type Media } from './media.js';
import { checkStructure } from './structure.js';
import { checkInstance, compileSchema } from './schema.js';

export interface Integrity {
  readonly algorithm: 'sha-256' | 'sha-512';
  readonly value: string;
}
export interface SchemaDescriptor {
  readonly mediaType: string;
  readonly dialect?: string;
  readonly inline?: JsonValue;
  readonly uri?: string;
  readonly integrity?: Integrity;
  readonly bundle?: {
    readonly uri: string;
    readonly mediaType: string;
    readonly integrity?: Integrity;
  };
  readonly entrypoint?: string;
}
export interface Representation {
  readonly id: string;
  readonly mediaType: string;
  readonly description?: string;
  readonly schema?: SchemaDescriptor;
}
export interface ContractDirection {
  readonly presence: Presence;
  readonly representations?: readonly Representation[];
}
export interface Contract {
  readonly id: string;
  readonly input: ContractDirection;
  readonly output: ContractDirection;
  readonly description?: string;
  readonly skillIds?: readonly string[];
  readonly supersedes?: readonly string[];
}
export interface PreparedRepresentation {
  readonly contractId: string;
  readonly direction: Direction;
  readonly representation: Representation;
  readonly codec: Media;
  /** Returns a frozen validated snapshot; never asserts a domain-specific generic. */
  validate(value: unknown, origin?: 'local' | 'remote'): JsonValue;
}
export interface RepresentationCapability {
  readonly representation: Representation;
  readonly supported: boolean;
  readonly diagnostic?: DiagnosticCode;
}
export interface ContractCatalog {
  readonly contracts: readonly Contract[];
  getContract(id: string, origin?: 'local' | 'remote'): Contract;
  select(
    contractId: string,
    direction: Direction,
    representationId: string,
    origin?: 'local' | 'remote',
  ): PreparedRepresentation;
  capabilities(contractId: string, direction: Direction): readonly RepresentationCapability[];
}

/** Structural catalog validation preserves unsupported alternatives for truthful discovery. */
export function parseCatalog(
  value: unknown,
  origin: 'local' | 'remote' = 'local',
): ContractCatalog {
  return createCatalog(value, origin, (descriptor, context) => {
    if (!Object.hasOwn(descriptor, 'inline')) fail('SCHEMA_UNAVAILABLE', context);
    if (descriptor.dialect !== JSON_SCHEMA_DIALECT) fail('UNSUPPORTED_DIALECT', context);
    if (descriptor.mediaType !== 'application/schema+json') fail('UNSUPPORTED_MEDIA_TYPE', context);
    return compileSchema(descriptor.inline!, context);
  });
}

/** Internal construction seam; no unchecked compiler is exposed in the public export map. */
export function createCatalog(
  value: unknown,
  origin: 'local' | 'remote',
  compile: (descriptor: SchemaDescriptor, context: ErrorContext) => ValidateFunction,
): ContractCatalog {
  const context: ErrorContext = { origin };
  const data = snapshot(value, context);
  checkStructure('catalog', data, context);
  // Cast only after the pinned structural validator, never from unchecked discovery data.
  const contracts = (data as unknown as { contracts: readonly Contract[] }).contracts;
  const ids = new Set<string>();
  for (const contract of contracts) {
    if (!versionedId(contract.id) || contract.supersedes?.some((id) => !versionedId(id)))
      fail('INVALID_IDENTIFIER', context);
    if (ids.has(contract.id)) fail('DUPLICATE_IDENTIFIER', context);
    ids.add(contract.id);
    for (const direction of [contract.input, contract.output]) {
      const representations = new Set<string>();
      for (const representation of direction.representations ?? []) {
        if (representations.has(representation.id)) fail('DUPLICATE_IDENTIFIER', context);
        representations.add(representation.id);
      }
    }
  }
  function getContract(
    id: string,
    source: 'local' | 'remote' = origin,
    direction?: Direction,
  ): Contract {
    if (!versionedId(id)) fail('INVALID_IDENTIFIER', { origin: source });
    const contract = contracts.find((contract) => contract.id === id);
    if (!contract)
      fail('CONTRACT_NOT_FOUND', {
        origin: source,
        contractId: id,
        ...(direction === undefined ? {} : { direction }),
      });
    return contract;
  }
  function select(
    contractId: string,
    direction: Direction,
    representationId: string,
    source: 'local' | 'remote' = origin,
  ): PreparedRepresentation {
    if (direction !== 'input' && direction !== 'output')
      fail('INVALID_STRUCTURE', { origin: source });
    const contract = getContract(contractId, source, direction);
    const base = { origin: source, contractId, direction };
    const representation = contract[direction].representations?.find(
      (rep) => rep.id === representationId,
    );
    if (!representation) fail('REPRESENTATION_NOT_SUPPORTED', base);
    const scoped = { ...base, representationId: representation.id };
    const codec = media(representation.mediaType, scoped);
    let validateSchema: ValidateFunction | undefined;
    if (representation.schema !== undefined) {
      validateSchema = compile(representation.schema, scoped);
    }
    return Object.freeze({
      contractId,
      direction,
      representation,
      codec,
      validate(value: unknown, validationOrigin: 'local' | 'remote' = source): JsonValue {
        const validationContext = { ...scoped, origin: validationOrigin };
        const copy = snapshot(value, validationContext);
        if (codec === 'text' && typeof copy !== 'string')
          fail('INVALID_CARRIER', validationContext);
        if (validateSchema !== undefined) checkInstance(validateSchema, copy, validationContext);
        return copy;
      },
    });
  }
  return Object.freeze({
    contracts,
    getContract,
    select,
    capabilities(contractId: string, direction: Direction): readonly RepresentationCapability[] {
      const contract = getContract(contractId);
      if (direction !== 'input' && direction !== 'output') fail('INVALID_STRUCTURE', context);
      return Object.freeze(
        (contract[direction].representations ?? []).map((representation) => {
          try {
            select(contractId, direction, representation.id);
            return Object.freeze({ representation, supported: true });
          } catch (error) {
            return Object.freeze({
              representation,
              supported: false,
              diagnostic: (error as ContractError).code,
            });
          }
        }),
      );
    },
  });
}

export function parseExtensionParams(
  value: unknown,
  origin: 'local' | 'remote' = 'remote',
): ContractCatalog {
  const context = { origin };
  const data = snapshot(value, context);
  checkStructure('extension-params', data, context);
  const catalog = (data as { catalog: { readonly [key: string]: JsonValue } }).catalog;
  if (!Object.hasOwn(catalog, 'inline')) fail('SCHEMA_UNAVAILABLE', context);
  return parseCatalog(catalog.inline, origin);
}

/** Parse a discovered AgentExtension; activation and AgentCard binding are adapter work. */
export function parseExtension(
  value: unknown,
  origin: 'local' | 'remote' = 'remote',
): ContractCatalog {
  const context = { origin };
  const data = snapshot(value, context);
  if (!isRecord(data) || typeof data.uri !== 'string') fail('INVALID_STRUCTURE', context);
  if (data.uri !== EXTENSION_URI) fail('VERSION_MISMATCH', context);
  if (data.required !== undefined && typeof data.required !== 'boolean')
    fail('INVALID_STRUCTURE', context);
  return parseExtensionParams(data.params, origin);
}
