import {
  AgentCard,
  Artifact,
  Message,
  Part,
  Role,
  SendMessageRequest,
  Task,
  TaskArtifactUpdateEvent,
  TaskState,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import { A2AError, ExtensionSupportRequiredError } from '@a2a-js/sdk/errors';
import {
  type A2ARequestHandler,
  AgentEvent,
  type AgentExecutionEvent,
  type AgentExecutor,
  DefaultExecutionEventBus,
  DefaultRequestHandler,
  type ExecutionEventBus,
  type RequestContext,
  type ServerCallContext,
  type TaskStore,
} from '@a2a-js/sdk/server';

import {
  checkEcho,
  cloneArtifact,
  consumeResult,
  type ContractSelection,
  echo,
  guardContainer,
  guardJsonRpcRequest,
  mapped,
  reject,
  stopStates,
} from '../adapters/a2a-js/boundary.js';
import {
  type AdvertisementOptions,
  type ContractCatalog,
  ContractError,
  createContractExtension,
  encodePrimary,
  EXTENSION_URI,
  type JsonValue,
  parseCatalog,
} from '../core/index.js';
import { isRecord, snapshot } from '../core/json.js';
import {
  createValidationSession,
  lazyCatalog,
  type ValidationOptions,
} from '../operations/index.js';
import { preparedCatalog } from '../resolver/prepared.js';
export { EXTENSION_URI } from '../core/index.js';

export const SERVER_LIMITS = Object.freeze({
  events: 128,
  bytes: 262144,
  deadlineMs: 30000,
  executions: 4,
});
export interface ExecutionContract extends ContractSelection {
  readonly signal: AbortSignal;
}
export interface ContractServerOptions {
  readonly card: AgentCard;
  readonly catalog: unknown;
  readonly taskStore: TaskStore;
  readonly executor: AgentExecutor;
  readonly required?: boolean;
  /** External delivery uses only a catalog resolved from that external descriptor. */
  readonly catalogDelivery?: 'inline' | 'external';
  readonly validation?: ValidationOptions;
  /** May lower the hard bound on active application executions. */
  readonly concurrentExecutions?: number;
  /** May shorten the fixed maximum execution deadline. */
  readonly deadlineMs?: number;
  /** Application-owned disconnect/abort signal; never implies a CancelTask call. */
  readonly signal?: (context: ServerCallContext) => AbortSignal | undefined;
}
export interface ContractServer {
  readonly card: AgentCard;
  readonly catalog: ContractCatalog;
  readonly handler: A2ARequestHandler;
  /** Mount after JSON parsing and before the official JSON-RPC handler. */
  guard(value: unknown): void;
  execution(context: RequestContext): ExecutionContract;
  close(): Promise<void>;
}
/** Advertise a validated private catalog snapshot without modifying the application card. */
export function advertiseContracts(
  card: AgentCard,
  catalog: ContractCatalog,
  required = false,
  catalogDelivery: AdvertisementOptions['catalogDelivery'] = 'inline',
): AgentCard {
  const copy = AgentCard.fromJSON(AgentCard.toJSON(card));
  if (!copy.capabilities) reject();
  copy.capabilities.extensions = copy.capabilities.extensions.filter(
    (e) => e.uri !== EXTENSION_URI,
  );
  copy.capabilities.extensions.push(
    createContractExtension(catalog, { required, catalogDelivery }),
  );
  return copy;
}
/** All three boundaries use public official SDK interfaces and the existing TaskStore. */
export function createContractServer(options: ContractServerOptions): ContractServer {
  const deadline = options.deadlineMs ?? SERVER_LIMITS.deadlineMs;
  if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > SERVER_LIMITS.deadlineMs)
    throw new TypeError('Invalid execution deadline.');
  const maximumExecutions = options.concurrentExecutions ?? SERVER_LIMITS.executions;
  if (
    !Number.isSafeInteger(maximumExecutions) ||
    maximumExecutions < 1 ||
    maximumExecutions > SERVER_LIMITS.executions
  )
    throw new TypeError('Invalid execution concurrency.');
  const catalog = preparedCatalog(options.catalog) ?? parseCatalog(options.catalog);
  const card = advertiseContracts(options.card, catalog, options.required, options.catalogDelivery);
  const validation = createValidationSession(catalog, options.validation);
  const publicCatalog = lazyCatalog(catalog);
  const selections = new WeakMap<ServerCallContext, ContractSelection>();
  const executions = new WeakMap<RequestContext, ExecutionContract>();
  const active = new Map<string, AbortController>();
  const turns = new Set<string>();
  const key = (context: ServerCallContext, taskId: string) =>
    JSON.stringify([context.tenant ?? '', taskId]);
  async function prepare(request: SendMessageRequest, context: ServerCallContext): Promise<void> {
    if (!context.requestedExtensions?.includes(EXTENSION_URI)) {
      if (options.required)
        throw new ExtensionSupportRequiredError('Schema Contract activation required.');
      if (
        request.metadata?.[EXTENSION_URI] !== undefined ||
        request.message?.metadata?.[EXTENSION_URI] !== undefined ||
        request.message?.parts.some((p) => p.metadata?.[EXTENSION_URI] !== undefined)
      )
        throw mapped(new Error());
      if (request.message?.taskId) {
        const task = await delegate.getTask(
          { id: request.message.taskId, tenant: request.tenant },
          context,
        );
        if (task.metadata?.[EXTENSION_URI] !== undefined) throw mapped(new Error());
      }
      return;
    }
    try {
      const selected = await validation.run<{
        invocation: ContractSelection['invocation'];
        input: ContractSelection['input'];
        outputRepresentationId?: string;
      }>('request', SendMessageRequest.toJSON(request));
      const selection: ContractSelection = {
        invocation: selected.invocation,
        input: snapshot(selected.input, {
          origin: 'remote',
        }) as unknown as ContractSelection['input'],
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
      if (request.message?.taskId) {
        const task = await delegate.getTask(
          { id: request.message.taskId, tenant: request.tenant },
          context,
        );
        const stored = task.metadata?.[EXTENSION_URI] as
          { contractId?: unknown; outputRepresentationId?: unknown } | undefined;
        if (
          stored?.contractId !== selection.invocation.contractId ||
          stored.outputRepresentationId !== selection.output?.representation.id ||
          task.status?.state !== TaskState.TASK_STATE_INPUT_REQUIRED ||
          active.has(key(context, task.id))
        )
          reject();
      }
      selections.set(context, selection);
      context.addActivatedExtension(EXTENSION_URI);
    } catch (error) {
      if (error instanceof A2AError) throw error;
      throw mapped(error);
    }
  }
  function failure(
    context: RequestContext,
    bus: ExecutionEventBus,
    selection: ContractSelection | undefined,
    canceled = false,
    started = false,
  ): void {
    const metadata =
      selection && !canceled
        ? {
            [EXTENSION_URI]: {
              code: 'OUTPUT_CONTRACT_VIOLATION',
              contractId: selection.invocation.contractId,
              direction: 'output',
            },
          }
        : undefined;
    if (started) {
      bus.publish(
        AgentEvent.statusUpdate(
          TaskStatusUpdateEvent.fromJSON({
            taskId: context.taskId,
            contextId: context.contextId,
            status: { state: canceled ? 'TASK_STATE_CANCELED' : 'TASK_STATE_FAILED' },
            ...(metadata ? { metadata } : {}),
          }),
        ),
      );
      return;
    }
    bus.publish(
      AgentEvent.task(
        Task.fromJSON({
          id: context.taskId,
          contextId: context.contextId,
          status: { state: canceled ? 'TASK_STATE_CANCELED' : 'TASK_STATE_FAILED' },
          ...(metadata ? { metadata } : {}),
        }),
      ),
    );
  }
  const executor: AgentExecutor = {
    async execute(context, bus) {
      const selection = selections.get(context.context);
      selections.delete(context.context);
      const controller = new AbortController();
      const taskKey = key(context.context, context.taskId);
      if (active.has(taskKey) || active.size >= maximumExecutions) {
        failure(context, bus, selection);
        return;
      }
      active.set(taskKey, controller);
      let signal: AbortSignal;
      try {
        const applicationSignal = options.signal?.(context.context);
        signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(deadline),
          ...(applicationSignal ? [applicationSignal] : []),
        ]);
      } catch {
        active.delete(taskKey);
        failure(context, bus, selection);
        return;
      }
      if (selection) executions.set(context, Object.freeze({ ...selection, signal }));
      const staged: AgentExecutionEvent[] = [];
      let bytes = 0;
      let open = true;
      let invalid = false;
      let started = false;
      const staging = new DefaultExecutionEventBus();
      staging.publish = (event) => {
        if (!open) return;
        try {
          let copy: AgentExecutionEvent;
          switch (event.kind) {
            case 'task': {
              const wire = snapshot(Task.toJSON(event.data), { origin: 'local' });
              guardContainer(wire);
              copy = AgentEvent.task(Task.fromJSON(wire));
              break;
            }
            case 'message': {
              const wire = snapshot(Message.toJSON(event.data), { origin: 'local' });
              guardContainer(wire);
              copy = AgentEvent.message(Message.fromJSON(wire));
              break;
            }
            case 'statusUpdate': {
              const wire = snapshot(TaskStatusUpdateEvent.toJSON(event.data), { origin: 'local' });
              guardContainer(wire);
              copy = AgentEvent.statusUpdate(TaskStatusUpdateEvent.fromJSON(wire));
              break;
            }
            case 'artifactUpdate': {
              if (!event.data.artifact) reject();
              cloneArtifact(event.data.artifact);
              const wire = snapshot(TaskArtifactUpdateEvent.toJSON(event.data), {
                origin: 'local',
              });
              copy = AgentEvent.artifactUpdate(TaskArtifactUpdateEvent.fromJSON(wire));
              break;
            }
          }
          bytes += Buffer.byteLength(JSON.stringify(copy));
          if (staged.length >= SERVER_LIMITS.events || bytes > SERVER_LIMITS.bytes)
            throw new ContractError('RESOURCE_LIMIT', { origin: 'local' });
          if (
            staged.length === 0 &&
            copy.kind === 'task' &&
            copy.data.status?.state === TaskState.TASK_STATE_WORKING &&
            copy.data.artifacts.length === 0
          ) {
            if (
              copy.data.id !== context.taskId ||
              copy.data.contextId !== context.contextId ||
              copy.data.history.length
            )
              reject();
            if (selection) {
              const association = echo(selection, selection.output !== undefined);
              checkEcho(copy.data.metadata, association);
              copy.data.metadata = { ...copy.data.metadata, [EXTENSION_URI]: association };
            }
            bus.publish(copy);
            started = true;
          }
          staged.push(copy);
        } catch (error) {
          invalid = true;
          throw error;
        }
      };
      // The wrapped executor cannot finish the real bus or install listeners on it.
      staging.finished = () => {
        open = false;
      };
      try {
        signal.throwIfAborted();
        const aborted = new Promise<never>((_, rejectAbort) => {
          signal.addEventListener('abort', () => rejectAbort(new Error('Execution aborted.')), {
            once: true,
          });
        });
        // Install both race handlers before invoking a callback that may throw synchronously.
        await Promise.race([
          Promise.resolve().then(() => {
            signal.throwIfAborted();
            return options.executor.execute(context, staging);
          }),
          aborted,
        ]);
        open = false;
        if (invalid) reject();
        if (selection) {
          const normalized = await validation.run<WireEvent[]>(
            'events',
            {
              request: SendMessageRequest.toJSON(context.request),
              events: encodeEvents(staged),
              context: { taskId: context.taskId, contextId: context.contextId },
              started,
            },
            { signal },
          );
          staged.splice(0, staged.length, ...decodeEvents(normalized));
        } else validateEvents(context, staged, catalog, selection, started);
        for (const event of staged.slice(started ? 1 : 0)) {
          signal.throwIfAborted();
          bus.publish(event);
        }
      } catch {
        open = false;
        failure(context, bus, selection, controller.signal.aborted, started);
      } finally {
        open = false;
        active.delete(taskKey);
        executions.delete(context);
        controller.abort();
        staging.removeAllListeners();
      }
    },
    async cancelTask(taskId, bus) {
      // DefaultRequestHandler has already authorized the TaskStore lookup.
      // Cancel controllers are scoped by the handler wrapper below.
      try {
        const cancellation = new DefaultExecutionEventBus();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            options.executor.cancelTask(taskId, cancellation),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, deadline);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
          cancellation.removeAllListeners();
        }
      } catch {
        /* never disclose business exception text */
      }
      // Active execution publishes the correlated canceled event on this bus.
      void bus;
    },
  };
  const delegate = new DefaultRequestHandler(
    card,
    options.taskStore,
    executor,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { keepBusAliveStates: [] },
  );
  const handler: A2ARequestHandler = {
    getAgentCard: delegate.getAgentCard.bind(delegate),
    getAuthenticatedExtendedAgentCard: delegate.getAuthenticatedExtendedAgentCard.bind(delegate),
    getTask: delegate.getTask.bind(delegate),
    listTasks: delegate.listTasks.bind(delegate),
    createTaskPushNotificationConfig: delegate.createTaskPushNotificationConfig.bind(delegate),
    getTaskPushNotificationConfig: delegate.getTaskPushNotificationConfig.bind(delegate),
    listTaskPushNotificationConfigs: delegate.listTaskPushNotificationConfigs.bind(delegate),
    deleteTaskPushNotificationConfig: delegate.deleteTaskPushNotificationConfig.bind(delegate),
    resubscribe: delegate.resubscribe.bind(delegate),
    async cancelTask(params, context) {
      await delegate.getTask({ id: params.id, tenant: params.tenant }, context);
      active.get(key(context, params.id))?.abort();
      return delegate.cancelTask(params, context);
    },
    async sendMessage(request, context) {
      const turn = request.message?.taskId ? key(context, request.message.taskId) : undefined;
      if (turn && turns.has(turn)) throw mapped(new Error());
      if (turn) turns.add(turn);
      try {
        await prepare(request, context);
        return await delegate.sendMessage(request, context);
      } finally {
        if (turn) turns.delete(turn);
        selections.delete(context);
      }
    },
    async *sendMessageStream(request, context) {
      const turn = request.message?.taskId ? key(context, request.message.taskId) : undefined;
      if (turn && turns.has(turn)) throw mapped(new Error());
      if (turn) turns.add(turn);
      try {
        await prepare(request, context);
        yield* delegate.sendMessageStream(request, context);
      } finally {
        if (turn) turns.delete(turn);
        selections.delete(context);
      }
    },
  };
  return Object.freeze({
    card,
    catalog,
    handler,
    async close() {
      for (const controller of active.values()) controller.abort();
      await validation.close();
    },
    guard(value: unknown) {
      try {
        guardJsonRpcRequest(value);
      } catch (error) {
        if (error instanceof ContractError && error.code === 'UNSUPPORTED_CARRIER') {
          const raw = snapshot(value, { origin: 'remote' });
          if (
            isRecord(raw) &&
            raw.params !== undefined &&
            isRecord(raw.params) &&
            raw.params.metadata !== undefined &&
            isRecord(raw.params.metadata)
          ) {
            const invocation = raw.params.metadata[EXTENSION_URI];
            if (
              invocation !== undefined &&
              isRecord(invocation) &&
              typeof invocation.contractId === 'string'
            ) {
              try {
                const contract = catalog.getContract(invocation.contractId);
                throw mapped(
                  new ContractError('UNSUPPORTED_CARRIER', {
                    origin: 'remote',
                    contractId: contract.id,
                    direction: 'input',
                  }),
                );
              } catch (identified) {
                if (!(identified instanceof ContractError)) throw identified;
              }
            }
          }
        }
        throw mapped(error);
      }
    },
    execution(context: RequestContext) {
      const current = executions.get(context);
      if (!current) throw new Error('No active Schema Contract execution.');
      return current;
    },
  });
}
export function validateEvents(
  context: RequestContext,
  events: AgentExecutionEvent[],
  catalog: ContractCatalog,
  selection: ContractSelection | undefined,
  started: boolean,
): void {
  const first = events[0];
  if (!first || (first.kind !== 'task' && first.kind !== 'message')) reject();
  if (first.kind === 'message') {
    if (
      events.length !== 1 ||
      first.data.role !== Role.ROLE_AGENT ||
      first.data.contextId !== context.contextId ||
      (first.data.taskId && first.data.taskId !== context.taskId)
    )
      reject();
    if (selection) consumeResult(catalog, selection, first.data);
    return;
  }
  const task = Task.fromJSON(Task.toJSON(first.data));
  if (started && task.metadata) delete task.metadata[EXTENSION_URI];
  if (task.id !== context.taskId || task.contextId !== context.contextId || !task.status) reject();
  let stopped = stopStates.has(task.status.state);
  const artifacts = new Map(task.artifacts.map((a) => [a.artifactId, a]));
  if (artifacts.size !== task.artifacts.length) reject();
  for (const event of events.slice(1)) {
    if (
      stopped ||
      event.kind === 'task' ||
      event.kind === 'message' ||
      event.data.taskId !== context.taskId ||
      event.data.contextId !== context.contextId
    )
      reject();
    if (event.kind === 'artifactUpdate') {
      if (
        !event.data.artifact ||
        event.data.append ||
        !event.data.lastChunk ||
        artifacts.has(event.data.artifact.artifactId)
      )
        reject();
      artifacts.set(event.data.artifact.artifactId, event.data.artifact);
    } else {
      if (!event.data.status) reject();
      task.status = event.data.status;
      task.metadata = { ...task.metadata, ...event.data.metadata };
      stopped = stopStates.has(task.status.state);
    }
  }
  if (!stopped || !task.status) reject();
  for (const event of events) {
    const message =
      event.kind === 'task'
        ? event.data.status?.message
        : event.kind === 'statusUpdate'
          ? event.data.status?.message
          : undefined;
    if (message?.parts.some((part) => part.metadata?.[EXTENSION_URI] !== undefined)) reject();
  }
  task.artifacts = [...artifacts.values()];
  if (!selection) return;
  const present = task.artifacts.some((a) =>
    a.parts.some((p) => p.metadata?.[EXTENSION_URI] !== undefined),
  );
  const resultEcho = echo(selection, present);
  if (task.status.state === TaskState.TASK_STATE_INPUT_REQUIRED) {
    if (present) reject();
    const association = echo(selection, selection.output !== undefined);
    checkEcho(task.metadata, association);
    task.metadata = { ...task.metadata, [EXTENSION_URI]: association };
    const last = events.at(-1)!;
    last.data.metadata = { ...last.data.metadata, [EXTENSION_URI]: association };
    return;
  }
  if (task.status.state !== TaskState.TASK_STATE_COMPLETED) {
    if (present) reject();
    return;
  }
  // Application helpers may supply echoes; conflicting echoes are never repaired.
  for (const event of events.slice(started ? 1 : 0)) checkEcho(event.data.metadata, resultEcho);
  checkEcho(task.metadata, resultEcho);
  for (const artifact of task.artifacts) checkEcho(artifact.metadata, resultEcho);
  const aggregate = Task.fromJSON(Task.toJSON(task));
  aggregate.metadata = { ...aggregate.metadata, [EXTENSION_URI]: resultEcho };
  consumeResult(catalog, selection, aggregate);
  const last = events.at(-1)!;
  last.data.metadata = { ...last.data.metadata, [EXTENSION_URI]: resultEcho };
}
/** Build an atomic primary for an executor using the negotiated output schema. */
export function outputPart(execution: ExecutionContract, value: unknown): Part {
  if (!execution.output)
    throw new ContractError('REPRESENTATION_NOT_SUPPORTED', {
      origin: 'local',
      contractId: execution.invocation.contractId,
      direction: 'output',
    });
  return Part.fromJSON(encodePrimary(execution.output, value, 'a2a-js-1.3.0'));
}
export function outputArtifact(
  execution: ExecutionContract,
  value: unknown,
  artifactId = 'result',
): Artifact {
  return Artifact.fromJSON({ artifactId, parts: [Part.toJSON(outputPart(execution, value))] });
}
export type { JsonValue };
export type { Direction, Presence } from '../core/index.js';

export interface WireEvent {
  readonly kind: AgentExecutionEvent['kind'];
  readonly data: unknown;
}
export function encodeEvents(events: readonly AgentExecutionEvent[]): WireEvent[] {
  return events.map((event) => {
    switch (event.kind) {
      case 'task':
        return { kind: event.kind, data: Task.toJSON(event.data) };
      case 'message':
        return { kind: event.kind, data: Message.toJSON(event.data) };
      case 'statusUpdate':
        return { kind: event.kind, data: TaskStatusUpdateEvent.toJSON(event.data) };
      case 'artifactUpdate':
        return { kind: event.kind, data: TaskArtifactUpdateEvent.toJSON(event.data) };
    }
  });
}
export function decodeEvents(events: readonly WireEvent[]): AgentExecutionEvent[] {
  return events.map((event) => {
    switch (event.kind) {
      case 'task':
        return AgentEvent.task(Task.fromJSON(event.data));
      case 'message':
        return AgentEvent.message(Message.fromJSON(event.data));
      case 'statusUpdate':
        return AgentEvent.statusUpdate(TaskStatusUpdateEvent.fromJSON(event.data));
      case 'artifactUpdate':
        return AgentEvent.artifactUpdate(TaskArtifactUpdateEvent.fromJSON(event.data));
    }
  });
}
