import type { Direction } from './constants.js';

export type DiagnosticCode =
  | 'INVALID_STRUCTURE'
  | 'INVALID_IDENTIFIER'
  | 'VERSION_MISMATCH'
  | 'DUPLICATE_IDENTIFIER'
  | 'CONTRACT_NOT_FOUND'
  | 'REPRESENTATION_NOT_SUPPORTED'
  | 'PAYLOAD_PRESENCE_VIOLATION'
  | 'PRIMARY_IDENTITY_MISMATCH'
  | 'INVALID_METADATA'
  | 'INVALID_CARRIER'
  | 'UNSUPPORTED_CARRIER'
  | 'NON_JSON_VALUE'
  | 'VALIDATION_TIMEOUT'
  | 'VALIDATION_ABORTED'
  | 'RESOURCE_LIMIT'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'UNSUPPORTED_DIALECT'
  | 'UNSUPPORTED_VOCABULARY'
  | 'UNSUPPORTED_KEYWORD'
  | 'UNSUPPORTED_REGEX'
  | 'UNSUPPORTED_NUMBER'
  | 'RESOLUTION_POLICY'
  | 'INTEGRITY_MISMATCH'
  | 'RESOLUTION_ABORTED'
  | 'RESOLUTION_TIMEOUT'
  | 'REFERENCE_CYCLE'
  | 'SCHEMA_UNAVAILABLE'
  | 'SCHEMA_INVALID'
  | 'INSTANCE_INVALID';
export type DraftErrorCode =
  | 'CONTRACT_NOT_FOUND'
  | 'REPRESENTATION_NOT_SUPPORTED'
  | 'PAYLOAD_PRESENCE_VIOLATION'
  | 'SCHEMA_UNAVAILABLE'
  | 'SCHEMA_INVALID'
  | 'INSTANCE_INVALID';
export interface ErrorDetail {
  readonly code: DraftErrorCode;
  readonly contractId: string;
  readonly direction: Direction;
  readonly representationId?: string;
}
export interface ErrorContext {
  readonly origin: 'local' | 'remote';
  readonly contractId?: string;
  readonly direction?: Direction;
  readonly representationId?: string;
}

/** Safe to log/serialize. No raw causes, values, schema paths or validator messages. */
export class ContractError extends Error {
  readonly code: DiagnosticCode;
  readonly origin: 'local' | 'remote';
  readonly detail: ErrorDetail | undefined;
  constructor(code: DiagnosticCode, context: ErrorContext) {
    super(`Schema Contract rejected: ${code}.`);
    this.name = 'ContractError';
    this.code = code;
    this.origin = context.origin;
    if (context.contractId !== undefined && context.direction !== undefined) {
      const draftCode: DraftErrorCode =
        code === 'CONTRACT_NOT_FOUND' ||
        code === 'SCHEMA_UNAVAILABLE' ||
        code === 'PAYLOAD_PRESENCE_VIOLATION' ||
        code === 'INSTANCE_INVALID'
          ? code
          : code === 'RESOLUTION_POLICY' ||
              code === 'INTEGRITY_MISMATCH' ||
              code === 'RESOLUTION_ABORTED' ||
              code === 'RESOLUTION_TIMEOUT' ||
              code === 'REFERENCE_CYCLE'
            ? 'SCHEMA_UNAVAILABLE'
            : code === 'REPRESENTATION_NOT_SUPPORTED' ||
                code === 'UNSUPPORTED_MEDIA_TYPE' ||
                code === 'UNSUPPORTED_CARRIER'
              ? 'REPRESENTATION_NOT_SUPPORTED'
              : code === 'SCHEMA_INVALID' ||
                  code === 'UNSUPPORTED_DIALECT' ||
                  code === 'UNSUPPORTED_VOCABULARY' ||
                  code === 'UNSUPPORTED_KEYWORD' ||
                  code === 'UNSUPPORTED_REGEX' ||
                  code === 'UNSUPPORTED_NUMBER'
                ? 'SCHEMA_INVALID'
                : 'INSTANCE_INVALID';
      this.detail = Object.freeze({
        code: draftCode,
        contractId: context.contractId,
        direction: context.direction,
        ...(context.representationId === undefined
          ? {}
          : { representationId: context.representationId }),
      });
    }
  }
}
export function fail(code: DiagnosticCode, context: ErrorContext): never {
  throw new ContractError(code, context);
}
