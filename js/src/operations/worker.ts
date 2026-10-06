import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createCatalog } from '../core/catalog.js';
import { ContractError, fail, type ErrorContext } from '../core/errors.js';
import {
  compileProgram,
  catalogCompiler,
  type CatalogProgram,
  type SchemaProgram,
} from './program.js';

export async function dispatchOperation(
  operation: string,
  value: Record<string, unknown>,
  program: CatalogProgram,
  context: ErrorContext,
): Promise<{
  value?: unknown;
  code?: import('../core/errors.js').DiagnosticCode;
  context?: ErrorContext;
}> {
  try {
    let result: unknown;
    if (operation === 'compile') {
      compileProgram(value as unknown as SchemaProgram, context);
      result = true;
    } else {
      const catalog = createCatalog(
        { contracts: program.contracts },
        context.origin,
        catalogCompiler(program),
      );
      if (operation === 'validate') {
        result = catalog
          .select(
            value.contractId as string,
            value.direction as 'input' | 'output',
            value.representationId as string,
            context.origin,
          )
          .validate(value.value, context.origin);
      } else if (operation === 'capabilities') {
        result = catalog.contracts.flatMap((contract) =>
          ['input', 'output'].map((direction) => ({
            contractId: contract.id,
            direction,
            capabilities: catalog.capabilities(contract.id, direction as 'input' | 'output'),
          })),
        );
      } else {
        const { Message, Task, SendMessageRequest } = await import('@a2a-js/sdk');
        const { selectRequest, consumeResult } = await import('../adapters/a2a-js/boundary.js');
        if (operation === 'request' || operation === 'prepare') {
          let request;
          if (operation === 'prepare') {
            const { prepareRequest } = await import('../client/index.js');
            request = prepareRequest(
              catalog,
              value as unknown as import('../client/index.js').InvocationOptions,
            );
          } else request = SendMessageRequest.fromJSON(value);
          const selection = selectRequest(catalog, request);
          result =
            operation === 'prepare'
              ? SendMessageRequest.toJSON(request)
              : {
                  invocation: selection.invocation,
                  input: selection.input,
                  ...(selection.output
                    ? { outputRepresentationId: selection.output.representation.id }
                    : {}),
                };
        } else {
          const request = SendMessageRequest.fromJSON(value.request);
          let selection = selectRequest(catalog, request);
          if (typeof value.outputRepresentationId === 'string')
            selection = {
              ...selection,
              output: catalog.select(
                selection.invocation.contractId,
                'output',
                value.outputRepresentationId,
                'remote',
              ),
            };
          if (operation === 'result') {
            const response = value.response as Record<string, unknown>;
            result = consumeResult(
              catalog,
              selection,
              Object.hasOwn(response, 'parts')
                ? Message.fromJSON(response)
                : Task.fromJSON(response),
            );
          } else if (operation === 'events') {
            const { validateEvents, decodeEvents, encodeEvents } =
              await import('../server/index.js');
            const events = decodeEvents(value.events as import('../server/index.js').WireEvent[]);
            validateEvents(
              value.context as import('@a2a-js/sdk/server').RequestContext,
              events,
              catalog,
              selection,
              value.started as boolean,
            );
            result = encodeEvents(events);
          } else fail('INVALID_STRUCTURE', context);
        }
      }
    }
    return { value: result };
  } catch (error) {
    if (error instanceof ContractError)
      return { code: error.code, context: { origin: error.origin, ...error.detail } };
    else return { code: 'RESOURCE_LIMIT', context };
  }
}
if (!isMainThread) {
  const { operation, value, program, context } = workerData as {
    operation: string;
    value: Record<string, unknown>;
    program: CatalogProgram;
    context: ErrorContext;
  };
  parentPort!.postMessage(await dispatchOperation(operation, value, program, context));
}
