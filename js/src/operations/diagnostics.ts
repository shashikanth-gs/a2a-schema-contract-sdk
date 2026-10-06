import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ContractError, type DiagnosticCode } from '../core/errors.js';

export interface DiagnosticEvent {
  readonly operation: 'discovery' | 'negotiation' | 'validation' | 'resolution';
  readonly correlationId: string;
  readonly durationMs: number;
  readonly outcome: 'success' | 'rejected';
  readonly code?: DiagnosticCode;
}
export type DiagnosticHook = (event: DiagnosticEvent) => void;
export async function observe<T>(
  operation: DiagnosticEvent['operation'],
  hook: DiagnosticHook | undefined,
  work: () => Promise<T>,
  correlationId: string = randomUUID(),
): Promise<T> {
  const start = performance.now();
  let error: unknown;
  try {
    return await work();
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    if (hook) {
      const event = Object.freeze({
        operation,
        correlationId,
        durationMs: performance.now() - start,
        outcome: error === undefined ? ('success' as const) : ('rejected' as const),
        ...(error instanceof ContractError ? { code: error.code } : {}),
      });
      try {
        hook(event);
      } catch {
        /* Diagnostics never change the validation decision. */
      }
    }
  }
}
