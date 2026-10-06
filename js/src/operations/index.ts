import { Worker } from 'node:worker_threads';
import { ContractError, fail, type DiagnosticCode, type ErrorContext } from '../core/errors.js';
import { snapshot } from '../core/json.js';
import type { ContractCatalog, PreparedRepresentation } from '../core/catalog.js';
import { media } from '../core/media.js';
import { catalogProgram, type CatalogProgram } from './program.js';
import { observe, type DiagnosticHook } from './diagnostics.js';

export type { DiagnosticEvent, DiagnosticHook } from './diagnostics.js';
export const VALIDATION_LIMITS = Object.freeze({ deadlineMs: 2000, concurrent: 4, memoryMb: 64 });
export interface ValidationOptions {
  readonly deadlineMs?: number;
  readonly concurrent?: number;
  readonly diagnostics?: DiagnosticHook;
}
export interface ValidationCallOptions {
  readonly signal?: AbortSignal;
  readonly context?: ErrorContext;
}
export interface ValidationSession {
  run<T = unknown>(operation: string, value: unknown, options?: ValidationCallOptions): Promise<T>;
  close(): Promise<void>;
  readonly active: number;
}
/** One owned worker per in-flight operation. Every outcome awaits physical termination. */
export function createValidationSession(
  catalog: ContractCatalog | CatalogProgram,
  options: ValidationOptions = {},
): ValidationSession {
  const deadlineMs = options.deadlineMs ?? VALIDATION_LIMITS.deadlineMs;
  const concurrent = options.concurrent ?? VALIDATION_LIMITS.concurrent;
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > VALIDATION_LIMITS.deadlineMs ||
    !Number.isSafeInteger(concurrent) ||
    concurrent < 1 ||
    concurrent > VALIDATION_LIMITS.concurrent
  )
    throw new TypeError('Invalid validation limits.');
  const program = 'getContract' in catalog ? catalogProgram(catalog) : catalog;
  const workers = new Map<Worker, () => void>();
  let closed = false;
  return Object.freeze({
    get active() {
      return workers.size;
    },
    async close() {
      closed = true;
      const pending = [...workers.keys()];
      for (const abort of workers.values()) abort();
      await Promise.all(pending.map((worker) => worker.terminate()));
    },
    async run<T>(operation: string, value: unknown, call: ValidationCallOptions = {}): Promise<T> {
      const context = call.context ?? { origin: 'remote' };
      return observe(
        operation === 'request' ? 'negotiation' : 'validation',
        options.diagnostics,
        async () => {
          if (closed || workers.size >= concurrent) fail('RESOURCE_LIMIT', context);
          if (call.signal?.aborted) fail('VALIDATION_ABORTED', context);
          // The worker receives only bounded JSON snapshots, never closures, logger objects or auth.
          const checked = snapshot(value, context);
          const data = operation === 'compile' ? value : checked;
          const worker = new Worker(new URL('../../dist/operations/worker.js', import.meta.url), {
            workerData: { operation, value: data, program, context },
            resourceLimits: { maxOldGenerationSizeMb: VALIDATION_LIMITS.memoryMb, stackSizeMb: 4 },
            execArgv: [],
            env: {},
          });
          let timer: ReturnType<typeof setTimeout> | undefined;
          let onAbort: (() => void) | undefined;
          try {
            return await new Promise<T>((resolve, reject) => {
              const aborted = () => reject(new ContractError('VALIDATION_ABORTED', context));
              workers.set(worker, aborted);
              onAbort = aborted;
              call.signal?.addEventListener('abort', aborted, { once: true });
              if (call.signal?.aborted) aborted();
              timer = setTimeout(
                () => reject(new ContractError('VALIDATION_TIMEOUT', context)),
                deadlineMs,
              );
              worker.once('error', () => reject(new ContractError('RESOURCE_LIMIT', context)));
              worker.once('exit', (code) => {
                if (code !== 0) reject(new ContractError('RESOURCE_LIMIT', context));
              });
              worker.once(
                'message',
                (message: { value?: T; code?: DiagnosticCode; context?: ErrorContext }) => {
                  if (message.code)
                    reject(new ContractError(message.code, message.context ?? context));
                  else resolve(message.value as T);
                },
              );
            });
          } finally {
            if (timer) clearTimeout(timer);
            if (onAbort) call.signal?.removeEventListener('abort', onAbort);
            await worker.terminate();
            workers.delete(worker);
          }
        },
      );
    },
  });
}
/** Preserve synchronous helpers for explicitly trusted application calls; async transport uses workers. */
export function lazyCatalog(catalog: ContractCatalog): ContractCatalog {
  return Object.freeze({
    contracts: catalog.contracts,
    getContract: (...args: Parameters<ContractCatalog['getContract']>) =>
      catalog.getContract(...args),
    capabilities: (...args: Parameters<ContractCatalog['capabilities']>) =>
      catalog.capabilities(...args),
    select(
      contractId: string,
      direction: 'input' | 'output',
      representationId: string,
      origin: 'local' | 'remote' = 'local',
    ): PreparedRepresentation {
      const contract = catalog.getContract(contractId, origin);
      const representation = contract[direction].representations?.find(
        (rep) => rep.id === representationId,
      );
      const context = { origin, contractId, direction, representationId };
      if (!representation) fail('REPRESENTATION_NOT_SUPPORTED', context);
      return Object.freeze({
        contractId,
        direction,
        representation,
        codec: media(representation.mediaType, context),
        validate: (value: unknown, source: 'local' | 'remote' = origin) =>
          catalog.select(contractId, direction, representationId, source).validate(value, source),
      });
    },
  });
}
