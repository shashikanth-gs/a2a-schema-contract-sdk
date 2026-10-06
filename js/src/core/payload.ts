import { EXTENSION_URI, type Direction, type JsonValue } from './constants.js';
import type { ContractCatalog, PreparedRepresentation } from './catalog.js';
import { fail, type ErrorContext } from './errors.js';
import { absoluteUri, isRecord, LIMITS, snapshot } from './json.js';
import { matchMediaTypes } from './media.js';
import { checkStructure } from './structure.js';

export type CarrierProfile = 'json' | 'a2a-js-1.3.0';
export type Payload =
  | { readonly present: false }
  | {
      readonly present: true;
      readonly value: JsonValue;
      readonly representationId: string;
      readonly part: JsonValue;
    };
export interface Invocation {
  readonly contractId: string;
  readonly inputRepresentationId?: string;
  readonly acceptedOutputRepresentationIds?: readonly string[];
}
export interface InvocationSelection {
  readonly invocation: Invocation;
  readonly input: Payload;
}

function namespaced(metadata: JsonValue, context: ErrorContext): JsonValue {
  if (!isRecord(metadata) || !Object.hasOwn(metadata, EXTENSION_URI))
    fail('INVALID_METADATA', context);
  return metadata[EXTENSION_URI]!;
}

function guardCarrier(
  part: JsonValue,
  context: ErrorContext,
  carrier: CarrierProfile,
): asserts part is { readonly [key: string]: JsonValue } {
  if (!isRecord(part)) fail('INVALID_CARRIER', context);
  const contents = ['text', 'data', 'raw', 'url'].filter((key) => Object.hasOwn(part, key));
  if (contents.length !== 1) fail('INVALID_CARRIER', context);
  if (Object.hasOwn(part, 'text') && typeof part.text !== 'string')
    fail('INVALID_CARRIER', context);
  if (
    Object.hasOwn(part, 'raw') &&
    (typeof part.raw !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(part.raw))
  )
    fail('INVALID_CARRIER', context);
  if (Object.hasOwn(part, 'url') && (typeof part.url !== 'string' || !absoluteUri(part.url)))
    fail('INVALID_CARRIER', context);
  if (part.mediaType !== undefined && typeof part.mediaType !== 'string')
    fail('INVALID_CARRIER', context);
  if (part.filename !== undefined && typeof part.filename !== 'string')
    fail('INVALID_CARRIER', context);
  if (part.metadata !== undefined && !isRecord(part.metadata)) fail('INVALID_METADATA', context);
  if (carrier === 'a2a-js-1.3.0' && part.data === null) fail('UNSUPPORTED_CARRIER', context);
}

/** Decode wire-shape Parts, not SDK-internal protobuf objects. Empty output is a Task collection. */
export function decodePrimary(
  catalog: ContractCatalog,
  contractId: string,
  direction: Direction,
  parts: unknown,
  representationId?: string,
  carrier: CarrierProfile = 'json',
): Payload {
  const contract = catalog.getContract(contractId, 'remote');
  if (direction !== 'input' && direction !== 'output')
    fail('INVALID_STRUCTURE', { origin: 'local' });
  const context: ErrorContext = { origin: 'remote', contractId, direction };
  const copy = snapshot(parts, context);
  if (!Array.isArray(copy) || (direction === 'input' && copy.length === 0))
    fail('INVALID_CARRIER', context);
  if (copy.length > LIMITS.parts) fail('RESOURCE_LIMIT', context);
  const primaries: { readonly [key: string]: JsonValue }[] = [];
  for (const part of copy as readonly JsonValue[]) {
    guardCarrier(part, context, carrier);
    const metadata = part.metadata ?? null;
    if (isRecord(metadata) && Object.hasOwn(metadata, EXTENSION_URI)) {
      const primary = namespaced(metadata, context);
      checkStructure('part-metadata', primary, context);
      const identity = primary as {
        contractId: string;
        direction: string;
        representationId: string;
      };
      if (identity.contractId !== contractId || identity.direction !== direction)
        fail('PRIMARY_IDENTITY_MISMATCH', context);
      primaries.push(part);
    }
  }
  const presence = contract[direction].presence;
  if (
    primaries.length > 1 ||
    (presence === 'required' && primaries.length !== 1) ||
    (presence === 'none' && primaries.length !== 0)
  )
    fail('PAYLOAD_PRESENCE_VIOLATION', context);
  const part = primaries[0];
  if (part === undefined) {
    if (representationId !== undefined) fail('INVALID_METADATA', context);
    return Object.freeze({ present: false });
  }
  const primary = namespaced(part.metadata!, context) as { representationId: string };
  if (representationId === undefined || primary.representationId !== representationId)
    fail('PRIMARY_IDENTITY_MISMATCH', context);
  const selected = catalog.select(contractId, direction, representationId, 'remote');
  if (
    typeof part.mediaType !== 'string' ||
    !matchMediaTypes(part.mediaType, selected.representation.mediaType)
  )
    fail('REPRESENTATION_NOT_SUPPORTED', context);
  const key = selected.codec === 'json' ? 'data' : 'text';
  if (!Object.hasOwn(part, key)) fail('UNSUPPORTED_CARRIER', context);
  const value = selected.validate(part[key], 'remote');
  return Object.freeze({ present: true, value, representationId, part });
}

/** Encode a validated primary without wrapping or changing its value. */
export function encodePrimary(
  selected: PreparedRepresentation,
  value: unknown,
  carrier: CarrierProfile = 'json',
): JsonValue {
  const copy = selected.validate(value, 'local');
  if (carrier === 'a2a-js-1.3.0' && copy === null)
    fail('UNSUPPORTED_CARRIER', {
      origin: 'local',
      contractId: selected.contractId,
      direction: selected.direction,
      representationId: selected.representation.id,
    });
  return Object.freeze({
    [selected.codec === 'json' ? 'data' : 'text']: copy,
    mediaType: selected.representation.mediaType,
    metadata: Object.freeze({
      [EXTENSION_URI]: Object.freeze({
        contractId: selected.contractId,
        direction: selected.direction,
        representationId: selected.representation.id,
        role: 'primary',
      }),
    }),
  });
}

/** Operation-scope metadata; A2A activation/output-mode negotiation belong to the adapter. */
export function validateInvocation(
  catalog: ContractCatalog,
  metadata: unknown,
  parts: unknown,
  carrier: CarrierProfile = 'json',
): InvocationSelection {
  const context: ErrorContext = { origin: 'remote' };
  const data = namespaced(snapshot(metadata, context), context);
  checkStructure('invocation-metadata', data, context);
  const invocation = data as unknown as Invocation;
  const contract = catalog.getContract(invocation.contractId, 'remote');
  const scoped = { ...context, contractId: contract.id, direction: 'output' as const };
  if (invocation.acceptedOutputRepresentationIds !== undefined) {
    if (contract.output.presence === 'none') fail('INVALID_METADATA', scoped);
    for (const id of invocation.acceptedOutputRepresentationIds)
      if (!contract.output.representations!.some((rep) => rep.id === id))
        fail('REPRESENTATION_NOT_SUPPORTED', scoped);
  }
  const input = decodePrimary(
    catalog,
    contract.id,
    'input',
    parts,
    invocation.inputRepresentationId,
    carrier,
  );
  return Object.freeze({ invocation, input });
}

/** Validate the result echo and complete primary collection independently of peer validation. */
export function validateResult(
  catalog: ContractCatalog,
  contractId: string,
  metadata: unknown,
  parts: unknown,
  expectedRepresentationId?: string,
  carrier: CarrierProfile = 'json',
): Payload {
  catalog.getContract(contractId, 'remote');
  const context: ErrorContext = { origin: 'remote', contractId, direction: 'output' };
  const data = namespaced(snapshot(metadata, context), context);
  checkStructure('result-metadata', data, context);
  const result = data as { contractId: string; outputRepresentationId?: string };
  if (
    result.contractId !== contractId ||
    (result.outputRepresentationId !== undefined &&
      expectedRepresentationId !== undefined &&
      result.outputRepresentationId !== expectedRepresentationId)
  )
    fail('PRIMARY_IDENTITY_MISMATCH', context);
  return decodePrimary(
    catalog,
    contractId,
    'output',
    parts,
    result.outputRepresentationId,
    carrier,
  );
}
