import {
  createValidationSession,
  lazyCatalog,
  type ValidationOptions,
} from '../operations/index.js';
import { observe } from '../operations/diagnostics.js';
import { randomUUID } from 'node:crypto';
import type { ContractResolver } from '../resolver/index.js';
import {
  AgentCard,
  Extensions,
  Message,
  Part,
  Role,
  SendMessageRequest,
  Task,
  TaskState,
  TaskStatusUpdateEvent,
  type StreamResponse,
} from '@a2a-js/sdk';
import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  ServiceParameters,
  withA2AExtensions,
  type Client,
  type RequestOptions,
} from '@a2a-js/sdk/client';
import {
  EXTENSION_URI,
  encodePrimary,
  matchMediaTypes,
  parseExtension,
  type ContractCatalog,
  type JsonValue,
  type Payload,
} from '../core/index.js';
import {
  guardContainer,
  guardParts,
  reject,
  selectRequest,
  stopStates,
  type ContractSelection,
} from '../adapters/a2a-js/boundary.js';

export { EXTENSION_URI } from '../core/index.js';

export interface InvocationOptions {
  readonly contractId: string;
  /** Omission is absence. An explicitly supplied undefined is invalid JSON. */
  readonly input?: { readonly representationId: string; readonly value: unknown };
  readonly acceptedOutputRepresentationIds?: readonly string[];
  readonly companions?: readonly JsonValue[];
  readonly configuration?: SendMessageRequest['configuration'];
  readonly metadata?: Record<string, unknown>;
  readonly taskId?: string;
  readonly contextId?: string;
  readonly tenant?: string;
}
export interface ContractResponse {
  readonly response: Message | Task;
  readonly payload: Payload | undefined;
}
export type ContractStreamEvent =
  | { readonly kind: 'companion'; readonly event: StreamResponse }
  | { readonly kind: 'result'; readonly result: ContractResponse };
export interface ContractClient {
  readonly client: Client;
  readonly catalog: ContractCatalog;
  readonly card: AgentCard;
  prepare(options: InvocationOptions): SendMessageRequest;
  close(): Promise<void>;
  invoke(options: InvocationOptions, requestOptions?: RequestOptions): Promise<ContractResponse>;
  stream(
    options: InvocationOptions,
    requestOptions?: RequestOptions,
  ): AsyncGenerator<ContractStreamEvent>;
}
/** Existing configured Client retains auth/interceptors; use guardResponseFetch in its transport. */
export async function createContractClient(
  client: Client,
  discoveryOptions?: RequestOptions,
  resolver?: ContractResolver,
  validationOptions: ValidationOptions = {},
): Promise<ContractClient> {
  if (client.protocolVersion !== '1.0' || client.transport.protocolName !== 'JSONRPC') reject();
  const card = await observe('discovery', validationOptions.diagnostics, () =>
    client.getAgentCard(discoveryOptions),
  );
  const extensions = card.capabilities?.extensions.filter((e) => e.uri === EXTENSION_URI) ?? [];
  if (extensions.length !== 1) reject();
  const catalog = resolver
    ? await resolver.resolveExtension(extensions[0], {
        ...(discoveryOptions?.signal ? { signal: discoveryOptions.signal } : {}),
      })
    : parseExtension(extensions[0]);
  const validation = createValidationSession(catalog, validationOptions);
  const publicCatalog = lazyCatalog(catalog);
  const prepare = (options: InvocationOptions) => prepareRequest(catalog, options);
  const prepareAsync = async (options: InvocationOptions, requestOptions?: RequestOptions) =>
    SendMessageRequest.fromJSON(
      await validation.run(
        'prepare',
        {
          ...options,
          ...(options.configuration
            ? {
                configuration: Object.fromEntries(
                  Object.entries(options.configuration).filter(([, value]) => value !== undefined),
                ),
              }
            : {}),
        },
        {
          context: { origin: 'local' },
          ...(requestOptions?.signal ? { signal: requestOptions.signal } : {}),
        },
      ),
    );
  async function selectionFor(
    request: SendMessageRequest,
    requestOptions?: RequestOptions,
  ): Promise<ContractSelection> {
    const selected = await validation.run<{
      invocation: ContractSelection['invocation'];
      input: Payload;
      outputRepresentationId?: string;
    }>(
      'request',
      SendMessageRequest.toJSON(request),
      requestOptions?.signal ? { signal: requestOptions.signal } : {},
    );
    return {
      invocation: selected.invocation,
      input: selected.input,
      ...(selected.outputRepresentationId
        ? {
            output: publicCatalog.select(
              selected.invocation.contractId,
              'output',
              selected.outputRepresentationId,
            ),
          }
        : {}),
    };
  }
  const activate = (options?: RequestOptions): RequestOptions => {
    const existing = Object.entries(options?.serviceParameters ?? {})
      .filter(([name]) => name.toLowerCase() === 'a2a-extensions')
      .flatMap(([, value]) => Extensions.parseServiceParameter(value));
    return {
      ...options,
      serviceParameters: ServiceParameters.createFrom(
        options?.serviceParameters,
        withA2AExtensions(...new Set([...existing, EXTENSION_URI])),
      ),
    };
  };
  async function checked(
    selection: ContractSelection,
    response: Message | Task,
    request: SendMessageRequest,
    requestOptions?: RequestOptions,
  ): Promise<ContractResponse> {
    if ('parts' in response) {
      if (
        response.role !== Role.ROLE_AGENT ||
        !response.messageId ||
        !response.contextId ||
        (request.message?.taskId && response.taskId !== request.message.taskId) ||
        (request.message?.contextId && response.contextId !== request.message.contextId)
      )
        reject();
    } else if (
      (request.message?.taskId && response.id !== request.message.taskId) ||
      (request.message?.contextId && response.contextId !== request.message.contextId)
    )
      reject();
    const metadata: unknown = response.metadata?.[EXTENSION_URI];
    if (
      isRecord(metadata) &&
      metadata.outputRepresentationId !== undefined &&
      (!('status' in response) ||
        response.status?.state === TaskState.TASK_STATE_COMPLETED ||
        response.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED)
    ) {
      const selectedId = metadata.outputRepresentationId;
      if (
        typeof selectedId !== 'string' ||
        (selection.invocation.acceptedOutputRepresentationIds &&
          !selection.invocation.acceptedOutputRepresentationIds.includes(selectedId))
      )
        reject();
      const output = publicCatalog.select(
        selection.invocation.contractId,
        'output',
        selectedId,
        'remote',
      );
      const modes = request.configuration?.acceptedOutputModes;
      if (
        modes?.length &&
        !modes.some((mode) => matchMediaTypes(mode, output.representation.mediaType))
      )
        reject();
      selection = Object.freeze({ ...selection, output });
    }
    const payload = await validation.run<Payload | undefined>(
      'result',
      {
        request: SendMessageRequest.toJSON(request),
        response: 'parts' in response ? Message.toJSON(response) : Task.toJSON(response),
        ...(selection.output ? { outputRepresentationId: selection.output.representation.id } : {}),
      },
      requestOptions?.signal ? { signal: requestOptions.signal } : {},
    );
    return Object.freeze({ response, payload });
  }
  return Object.freeze({
    client,
    catalog,
    card,
    close: () => validation.close(),
    prepare,
    async invoke(options: InvocationOptions, requestOptions?: RequestOptions) {
      const request = await prepareAsync(options, requestOptions);
      const selection = await selectionFor(request, requestOptions);
      return checked(
        selection,
        await client.sendMessage(request, activate(requestOptions)),
        request,
        requestOptions,
      );
    },
    async *stream(
      options: InvocationOptions,
      requestOptions?: RequestOptions,
    ): AsyncGenerator<ContractStreamEvent> {
      const request = await prepareAsync(options, requestOptions);
      const selection = await selectionFor(request, requestOptions);
      let task: Task | undefined;
      let count = 0;
      let bytes = 0;
      let done = false;
      const withheld: StreamResponse[] = [];
      for await (const event of client.sendMessageStream(request, activate(requestOptions))) {
        requestOptions?.signal?.throwIfAborted();
        if (
          ++count > 128 ||
          (bytes += Buffer.byteLength(JSON.stringify(event))) > 262144 ||
          done ||
          !event.payload
        )
          reject();
        const payload = event.payload;
        if (payload.$case === 'message') {
          if (task) reject();
          done = true;
          yield {
            kind: 'result',
            result: await checked(selection, payload.value, request, requestOptions),
          };
          continue;
        }
        if (payload.$case === 'task') {
          if (task) reject();
          task = Task.fromJSON(Task.toJSON(payload.value));
          guardContainer(Task.toJSON(task));
          if (!task.id || !task.contextId || !task.status) reject();
        } else {
          if (
            !task ||
            payload.value.taskId !== task.id ||
            payload.value.contextId !== task.contextId
          )
            reject();
          if (payload.$case === 'artifactUpdate') {
            const update = payload.value;
            if (
              !update.artifact ||
              update.append ||
              !update.lastChunk ||
              task.artifacts.some((a) => a.artifactId === update.artifact!.artifactId)
            )
              reject();
            guardParts(update.artifact.parts.map((p) => Part.toJSON(p)));
            task.artifacts.push(update.artifact);
          } else {
            if (!payload.value.status) reject();
            guardContainer(TaskStatusUpdateEvent.toJSON(payload.value));
            task.status = payload.value.status;
            task.metadata = { ...task.metadata, ...payload.value.metadata };
          }
        }
        if (!task.status) reject();
        if (stopStates.has(task.status.state)) {
          done = true;
          const result = await checked(selection, task, request, requestOptions);
          if (task.status.state === TaskState.TASK_STATE_COMPLETED) {
            for (const pending of withheld) yield { kind: 'companion', event: pending };
          }
          yield { kind: 'result', result };
        } else {
          // Output-bearing events are retained until the complete result echo and presence pass.
          if (task.artifacts.length || payload.$case === 'artifactUpdate') withheld.push(event);
          else {
            yield { kind: 'companion', event };
          }
        }
      }
      if (!done) reject();
    },
  });
}
export interface DiscoveryOptions {
  readonly resolver?: ContractResolver;
  readonly fetchImpl?: typeof fetch;
  readonly path?: string;
  readonly signal?: AbortSignal;
  readonly validation?: ValidationOptions;
}
export async function discoverContractClient(
  url: string,
  options: DiscoveryOptions = {},
): Promise<ContractClient> {
  const fetchImpl = guardResponseFetch(options.fetchImpl ?? fetch);
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl })],
    cardResolver: new DefaultAgentCardResolver({
      fetchImpl: (input, init) =>
        fetchImpl(input, {
          ...init,
          ...(options.signal
            ? { signal: AbortSignal.any([options.signal, ...(init?.signal ? [init.signal] : [])]) }
            : {}),
        }),
    }),
  });
  return createContractClient(
    await factory.createFromUrl(url, options.path),
    options.signal ? { signal: options.signal } : undefined,
    options.resolver,
    options.validation,
  );
}
function guardEnvelope(value: unknown): void {
  if (!isRecord(value) || !isRecord(value.result)) return;
  const result = value.result;
  if (
    ['task', 'message', 'statusUpdate', 'artifactUpdate'].filter((name) =>
      Object.hasOwn(result, name),
    ).length > 1
  )
    reject();
  guardContainer(result);
  for (const name of ['task', 'message', 'statusUpdate'])
    if (result[name] !== undefined) guardContainer(result[name]);
  if (isRecord(result.artifactUpdate)) {
    if (!isRecord(result.artifactUpdate.artifact)) reject();
    guardContainer({ artifacts: [result.artifactUpdate.artifact] });
  }
}
/** Protect raw JSON and SSE responses before protobuf normalization; bounded, cancelable reader. */
export function guardResponseFetch(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (!response.body || !response.ok) return response;
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json') && !contentType.includes('text/event-stream'))
      return response;
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '';
    const sse = contentType.includes('text/event-stream');
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          while (true) {
            const next = await reader.read();
            buffer += decoder.decode(next.value, { stream: !next.done });
            if (Buffer.byteLength(buffer) > 262144) reject();
            if (!sse && next.done) {
              guardEnvelope(JSON.parse(buffer) as unknown);
              controller.enqueue(encoder.encode(buffer));
              controller.close();
              return;
            }
            if (sse) {
              const frames = buffer.split(/\r?\n\r?\n/u);
              buffer = frames.pop()!;
              for (const frame of frames) {
                const data = frame
                  .split(/\r?\n/u)
                  .filter((line) => line.startsWith('data:'))
                  .map((line) => line.slice(5).trimStart())
                  .join('\n');
                if (data) guardEnvelope(JSON.parse(data) as unknown);
                controller.enqueue(encoder.encode(frame + '\n\n'));
              }
              if (next.done) {
                if (buffer.trim()) reject();
                controller.close();
                return;
              }
              if (frames.length) return;
            }
          }
        } catch (error) {
          await reader.cancel();
          controller.error(error);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason);
      },
    });
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function prepareRequest(
  catalog: ContractCatalog,
  options: InvocationOptions,
): SendMessageRequest {
  const contract = catalog.getContract(options.contractId);
  const parts: unknown[] = [];
  if (options.input)
    parts.push(
      encodePrimary(
        catalog.select(contract.id, 'input', options.input.representationId),
        options.input.value,
        'a2a-js-1.3.0',
      ),
    );
  if (options.companions) parts.push(...options.companions);
  if (!parts.length) parts.push({ text: 'Invoke contract.', mediaType: 'text/plain' });
  guardParts(parts);
  if (options.metadata?.[EXTENSION_URI] !== undefined) reject();
  const invocation = {
    contractId: contract.id,
    ...(options.input ? { inputRepresentationId: options.input.representationId } : {}),
    ...(options.acceptedOutputRepresentationIds === undefined
      ? {}
      : { acceptedOutputRepresentationIds: options.acceptedOutputRepresentationIds }),
  };
  const request = SendMessageRequest.fromJSON({
    message: {
      messageId: randomUUID(),
      role: 'ROLE_USER',
      parts,
      taskId: options.taskId ?? '',
      contextId: options.contextId ?? '',
    },
    metadata: { ...options.metadata, [EXTENSION_URI]: invocation },
    ...(options.configuration ? { configuration: options.configuration } : {}),
    ...(options.tenant === undefined ? {} : { tenant: options.tenant }),
  });
  selectRequest(catalog, request);
  return request;
}
