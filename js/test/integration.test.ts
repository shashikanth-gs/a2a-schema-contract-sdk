import { once } from 'node:events';
import express from 'express';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  AgentCard,
  Artifact,
  Message,
  Part,
  SendMessageRequest,
  Task,
  TaskState,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  ListTasksRequest,
  GetTaskRequest,
  CancelTaskRequest,
} from '@a2a-js/sdk';
import {
  AgentEvent,
  InMemoryTaskStore,
  ServerCallContext,
  type AgentExecutor,
  type RequestContext,
} from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { toJsonRpcError } from '@a2a-js/sdk/errors';
import { ContractError, EXTENSION_URI, type Presence } from '../src/core/index.js';
import {
  createContractServer,
  outputArtifact,
  outputPart,
  type ContractServer,
} from '../src/server/index.js';
import {
  createContractClient,
  discoverContractClient,
  guardResponseFetch,
  type ContractClient,
  type InvocationOptions,
} from '../src/client/index.js';
import { createContractResolver } from '../src/resolver/index.js';
import { guardJsonRpcRequest } from '../src/adapters/a2a-js/index.js';

const id = 'urn:example:integration:1';
const json = {
  id: 'json',
  mediaType: 'application/json',
  schema: {
    mediaType: 'application/schema+json',
    dialect: 'https://json-schema.org/draft/2020-12/schema',
    inline: {
      type: 'object',
      required: ['count'],
      properties: { count: { type: 'integer', minimum: 0 } },
      additionalProperties: false,
    },
  },
};
const text = { id: 'text', mediaType: 'text/plain; charset=UTF-8' };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function launch(
  input: Presence = 'required',
  output: Presence = 'required',
  required = false,
  representations = [json, text],
  deadlineMs = 30000,
  resolve = false,
  cancelHangs = false,
  syncThrows = false,
  concurrentExecutions = 4,
) {
  let calls = 0;
  const contractServerHolder: { value?: ContractServer } = {};
  const contexts: RequestContext[] = [];
  const signals: AbortSignal[] = [];
  let cancelCalls = 0;
  const executor: AgentExecutor = {
    async execute(context, bus) {
      calls++;
      contexts.push(context);
      const mode = context.request.metadata?.mode as string | undefined;
      if (!context.context.activatedExtensions?.includes(EXTENSION_URI)) {
        bus.publish(
          AgentEvent.message(
            Message.fromJSON({
              messageId: 'baseline',
              contextId: context.contextId,
              role: 'ROLE_AGENT',
              parts: [{ text: 'baseline' }],
            }),
          ),
        );
        return;
      }
      const execution = contractServerHolder.value!.execution(context);
      signals.push(execution.signal);
      if (mode === 'wait') {
        bus.publish(
          AgentEvent.task(
            Task.fromJSON({
              id: context.taskId,
              contextId: context.contextId,
              status: { state: 'TASK_STATE_WORKING' },
            }),
          ),
        );
        await new Promise<void>((resolve) =>
          execution.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return;
      }
      if (mode === 'stream-throw') {
        bus.publish(
          AgentEvent.task(
            Task.fromJSON({
              id: context.taskId,
              contextId: context.contextId,
              status: { state: 'TASK_STATE_WORKING' },
            }),
          ),
        );
        throw new Error('secret-stream');
      }
      if (mode === 'throw') throw new Error('secret-private-value');
      if (mode === 'empty') return;
      const value = execution.output?.codec === 'text' ? '' : { count: 7 };
      if (mode === 'message') {
        bus.publish(
          AgentEvent.message(
            Message.fromJSON({
              messageId: 'response',
              contextId: context.contextId,
              role: 'ROLE_AGENT',
              parts: [Part.toJSON(outputPart(execution, value))],
              metadata: {
                [EXTENSION_URI]: {
                  contractId: id,
                  outputRepresentationId: execution.output?.representation.id,
                },
              },
            }),
          ),
        );
        return;
      }
      const omit = output === 'none' || mode === 'omit' || mode === 'continue';
      const artifact = omit
        ? undefined
        : mode === 'invalid'
          ? Artifact.fromJSON({
              artifactId: 'result',
              parts: [
                {
                  data: { count: -1 },
                  mediaType: 'application/json',
                  metadata: {
                    [EXTENSION_URI]: {
                      contractId: id,
                      direction: 'output',
                      representationId: 'json',
                      role: 'primary',
                    },
                  },
                },
              ],
            })
          : outputArtifact(execution, value);
      const artifacts = artifact ? [artifact] : [];
      if (mode === 'companions') {
        artifacts[0]!.parts.push(Part.fromJSON({ text: 'summary' }));
        artifacts.push(
          Artifact.fromJSON({ artifactId: 'companion', parts: [{ data: { unrelated: true } }] }),
        );
      }
      if (mode === 'duplicate-id')
        artifacts.push(Artifact.fromJSON(Artifact.toJSON(artifacts[0]!)));
      if (mode === 'empty-id') artifacts[0]!.artifactId = '';
      if (mode === 'empty-artifact')
        artifacts.push(Artifact.fromJSON({ artifactId: 'empty', parts: [] }));
      if (mode === 'identity')
        artifacts[0]!.parts[0]!.metadata = {
          [EXTENSION_URI]: {
            role: 'primary',
            direction: 'output',
            representationId: 'json',
            contractId: 'urn:other:1',
          },
        };
      const streaming = mode === 'stream' || mode === 'append' || mode === 'second-primary';
      bus.publish(
        AgentEvent.task(
          Task.fromJSON({
            id: context.taskId,
            contextId: context.contextId,
            status: {
              state:
                streaming || mode === 'overflow'
                  ? 'TASK_STATE_WORKING'
                  : mode === 'continue'
                    ? 'TASK_STATE_INPUT_REQUIRED'
                    : 'TASK_STATE_COMPLETED',
            },
            artifacts: streaming ? [] : artifacts.map((a) => Artifact.toJSON(a)),
            ...(mode === 'bad-echo'
              ? { metadata: { [EXTENSION_URI]: { contractId: 'urn:other:1' } } }
              : {}),
          }),
        ),
      );
      if (mode === 'finish') bus.finished();
      if (mode === 'after-success') throw new Error('secret-after-success');
      if (mode === 'overflow') {
        for (let i = 0; i < 129; i++)
          bus.publish(
            AgentEvent.statusUpdate(
              TaskStatusUpdateEvent.fromJSON({
                taskId: context.taskId,
                contextId: context.contextId,
                status: { state: 'TASK_STATE_WORKING' },
              }),
            ),
          );
      }
      if (streaming) {
        bus.publish(
          AgentEvent.artifactUpdate(
            TaskArtifactUpdateEvent.fromJSON({
              taskId: context.taskId,
              contextId: context.contextId,
              artifact: artifact && {
                ...artifact,
                parts: artifact.parts.map((p) => Part.toJSON(p)),
              },
              append: mode === 'append',
              lastChunk: true,
            }),
          ),
        );
        if (mode === 'second-primary')
          bus.publish(
            AgentEvent.artifactUpdate(
              TaskArtifactUpdateEvent.fromJSON({
                taskId: context.taskId,
                contextId: context.contextId,
                artifact: {
                  artifactId: 'another',
                  parts: artifact!.parts.map((p) => Part.toJSON(p)),
                },
                lastChunk: true,
              }),
            ),
          );
        bus.publish(
          AgentEvent.statusUpdate(
            TaskStatusUpdateEvent.fromJSON({
              taskId: context.taskId,
              contextId: context.contextId,
              status: { state: 'TASK_STATE_COMPLETED' },
            }),
          ),
        );
      }
    },
    cancelTask() {
      cancelCalls++;
      if (cancelHangs) return new Promise<void>(() => {});
      return Promise.reject(new Error('secret-cancel'));
    },
  };
  if (syncThrows)
    executor.execute = () => {
      throw new Error('secret-synchronous-executor');
    };
  const app = express();
  const store = new InMemoryTaskStore();
  const card = AgentCard.fromJSON({
    name: 'Inline integration',
    description: 'Local deterministic',
    version: '1',
    supportedInterfaces: [{ url: '', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: { streaming: true },
    defaultInputModes: ['application/json', 'text/plain'],
    defaultOutputModes: ['application/json', 'text/plain'],
    skills: [],
  });
  const contractServer = createContractServer({
    card,
    catalog: resolve
      ? await createContractResolver().resolveCatalog(
          {
            contracts: [
              {
                id,
                input: { presence: input, ...(input === 'none' ? {} : { representations }) },
                output: { presence: output, ...(output === 'none' ? {} : { representations }) },
              },
            ],
          },
          { origin: 'local' },
        )
      : {
          contracts: [
            {
              id,
              input: { presence: input, ...(input === 'none' ? {} : { representations }) },
              output: { presence: output, ...(output === 'none' ? {} : { representations }) },
            },
          ],
        },
    taskStore: store,
    executor,
    required,
    deadlineMs,
    concurrentExecutions,
    signal: (context) => {
      if ((context.state.get('headers') as Record<string, unknown>)['x-signal-fail'])
        throw new Error('secret-signal-hook');
      if ((context.state.get('headers') as Record<string, unknown>)['x-pre-abort'])
        return AbortSignal.abort();
      return context.state.get('signal') as AbortSignal | undefined;
    },
  });
  contractServerHolder.value = contractServer;
  app.use(express.json({ limit: '256kb' }));
  app.use(
    '/.well-known/agent-card.json',
    agentCardHandler({ agentCardProvider: contractServer.handler }),
  );
  app.use('/rpc', (req, res, next) => {
    try {
      contractServer.guard(req.body as unknown);
      next();
    } catch (error) {
      res.json({
        jsonrpc: '2.0',
        id: (req.body as { id?: unknown }).id,
        error: toJsonRpcError(error),
      });
    }
  });
  app.use('/rpc', (req, res, next) => {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    return jsonRpcHandler({
      requestHandler: contractServer.handler,
      userBuilder: UserBuilder.noAuthentication,
      contextBuilder: (options) =>
        new ServerCallContext({
          ...(options.extensions ? { requestedExtensions: options.extensions } : {}),
          ...(options.requestedVersion ? { requestedVersion: options.requestedVersion } : {}),
          ...(options.user ? { user: options.user } : {}),
          state: new Map<string, unknown>([
            ['headers', options.headers],
            ['signal', controller.signal],
          ]),
        }),
    })(req, res, next);
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address.');
  const url = `http://127.0.0.1:${address.port}`;
  contractServer.card.supportedInterfaces[0]!.url = url + '/rpc';
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const client = await discoverContractClient(url);
  return {
    client,
    contractServer,
    url,
    contexts,
    signals,
    calls: () => calls,
    cancelCalls: () => cancelCalls,
  };
}
const invoke: InvocationOptions = {
  contractId: id,
  input: { representationId: 'json', value: { count: 1 } },
};
async function raw(url: string, params: unknown, active = true) {
  const response = await fetch(url + '/rpc', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'A2A-Version': '1.0',
      ...(active ? { 'A2A-Extensions': EXTENSION_URI } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params }),
    signal: AbortSignal.timeout(2000),
  });
  return (await response.json()) as {
    result?: { task?: { status: { state: string }; artifacts?: unknown[] }; message?: unknown };
    error?: { code: number; message: string };
  };
}

describe('real JSON-RPC installed-shape integration', () => {
  test('discovery, local validation, output validation and caller options/context', async () => {
    const app = await launch();
    expect(
      app.client.catalog.getContract(id).input.representations?.[0]?.schema?.inline,
    ).toMatchObject({ type: 'object' });
    const options = {
      serviceParameters: {
        Authorization: 'test-credential',
        'X-App': 'preserved',
        'A2A-Extensions': 'urn:another',
      },
      signal: AbortSignal.timeout(2000),
    };
    const original = structuredClone(options.serviceParameters);
    const result = await app.client.invoke(invoke, options);
    expect(result.payload).toMatchObject({
      present: true,
      value: { count: 7 },
      representationId: 'json',
    });
    expect(options.serviceParameters).toEqual(original);
    expect(
      (app.contexts[0]!.context.state.get('headers') as Record<string, string>)['a2a-extensions'],
    ).toContain('urn:another');
    expect(app.contexts[0]!.context.state.get('headers')).toMatchObject({
      authorization: 'test-credential',
      'x-app': 'preserved',
    });
    expect(app.contexts[0]!.request.message?.parts[0]?.content?.value).toEqual({ count: 1 });
    expect(app.calls()).toBe(1);
    await expect(
      app.client.invoke({ ...invoke, input: { representationId: 'json', value: { count: -1 } } }),
    ).rejects.toBeInstanceOf(ContractError);
    expect(app.calls()).toBe(1);
  });
  test.each(['required', 'optional', 'none'] as const)(
    'all %s input combinations and empty no-output Tasks',
    async (input) => {
      for (const output of ['required', 'optional', 'none'] as const) {
        const app = await launch(input, output);
        const result = await app.client.invoke({
          contractId: id,
          ...(input === 'required' ? { input: invoke.input! } : {}),
          metadata: output === 'optional' ? { mode: 'omit' } : {},
        });
        expect(result.payload?.present).toBe(output === 'required');
        if ('artifacts' in result.response && output === 'none')
          expect(result.response.artifacts).toEqual([]);
        expect(app.calls()).toBe(1);
      }
    },
  );
  test('optional primary presence and omission are distinct in both directions over HTTP', async () => {
    const app = await launch('optional', 'optional');
    for (const present of [false, true]) {
      for (const omit of [false, true]) {
        const result = await app.client.invoke({
          contractId: id,
          ...(present ? { input: invoke.input! } : {}),
          ...(omit ? { metadata: { mode: 'omit' } } : {}),
        });
        expect(result.payload?.present).toBe(!omit);
        expect(
          app.contexts.at(-1)!.userMessage.parts[0]!.metadata?.[EXTENSION_URI] !== undefined,
        ).toBe(present);
      }
    }
    expect(app.calls()).toBe(4);
    await expect(
      discoverContractClient(app.url, { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
  });
  test.each(['json', 'text'])(
    'JSON/text cross-media and empty text for %s input',
    async (representationId) => {
      const app = await launch();
      const result = await app.client.invoke({
        contractId: id,
        input: { representationId, value: representationId === 'text' ? '' : { count: 0 } },
        acceptedOutputRepresentationIds: [representationId === 'json' ? 'text' : 'json'],
      });
      expect(result.payload).toMatchObject({
        present: true,
        value: representationId === 'json' ? '' : { count: 7 },
      });
    },
  );
  test('primary selection ignores same-media input companions and multiple companion artifacts', async () => {
    const app = await launch();
    const result = await app.client.invoke({
      ...invoke,
      companions: [{ data: { unrelated: true }, mediaType: 'application/json' }, { text: '' }],
      metadata: { mode: 'companions' },
    });
    expect(result.payload).toMatchObject({ present: true, value: { count: 7 } });
    expect(app.contexts[0]!.userMessage.parts).toHaveLength(3);
    expect('artifacts' in result.response && result.response.artifacts).toHaveLength(2);
  });
  test('standalone Message result and output-mode intersection', async () => {
    const app = await launch();
    const result = await app.client.invoke({
      ...invoke,
      metadata: { mode: 'message' },
      configuration: {
        acceptedOutputModes: ['Text/Plain; Charset="utf-8"'],
        taskPushNotificationConfig: undefined,
        returnImmediately: false,
      },
    });
    expect(result.payload).toMatchObject({ present: true, value: '', representationId: 'text' });
    await expect(
      app.client.invoke({
        ...invoke,
        acceptedOutputRepresentationIds: ['json'],
        configuration: {
          acceptedOutputModes: ['text/plain'],
          taskPushNotificationConfig: undefined,
          returnImmediately: false,
        },
      }),
    ).rejects.toBeInstanceOf(ContractError);
    expect(app.calls()).toBe(1);
  });
  test('invalid wire input has zero execution and no task-history write', async () => {
    const app = await launch();
    const params = SendMessageRequest.toJSON(app.client.prepare(invoke)) as Record<string, unknown>;
    const message = params.message as Record<string, unknown>;
    for (const parts of [
      [{ text: 7 }],
      [{ text: '', data: {} }],
      [{ data: null }],
      [],
      [
        {
          data: { count: -1 },
          mediaType: 'application/json',
          metadata: {
            [EXTENSION_URI]: {
              role: 'primary',
              contractId: id,
              direction: 'input',
              representationId: 'json',
            },
          },
        },
      ],
    ]) {
      const response = await raw(app.url, { ...params, message: { ...message, parts } });
      expect(response.error?.code).toBe(
        Object.hasOwn(parts[0] ?? {}, 'data') && (parts[0] as { data?: unknown }).data === null
          ? -32005
          : -32602,
      );
    }
    expect(app.calls()).toBe(0);
    const listed = await app.client.client.listTasks(ListTasksRequest.fromJSON({}));
    expect(listed.tasks).toEqual([]);
  });
  test('required activation, optional baseline and concurrent isolation', async () => {
    const required = await launch('required', 'required', true);
    const denied = await raw(
      required.url,
      SendMessageRequest.toJSON(required.client.prepare(invoke)),
      false,
    );
    expect(denied.error?.code).toBe(-32008);
    expect(required.calls()).toBe(0);
    const app = await launch();
    const baseline = SendMessageRequest.fromJSON({
      message: { messageId: 'baseline', role: 'ROLE_USER', parts: [{ text: 'baseline' }] },
    });
    await Promise.all([app.client.invoke(invoke), app.client.client.sendMessage(baseline)]);
    expect(
      app.contexts.filter((c) => c.context.activatedExtensions?.includes(EXTENSION_URI)),
    ).toHaveLength(1);
    expect(
      app.contexts.filter((c) => !c.context.activatedExtensions?.includes(EXTENSION_URI)),
    ).toHaveLength(1);
    expect(
      (await raw(app.url, SendMessageRequest.toJSON(app.client.prepare(invoke)), false)).error
        ?.code,
    ).toBe(-32602);
  });
  test.each([
    'invalid',
    'throw',
    'empty',
    'identity',
    'bad-echo',
    'after-success',
    'append',
    'second-primary',
    'overflow',
    'empty-artifact',
    'empty-id',
    'duplicate-id',
  ])('sanitized failure and zero output publication for %s', async (mode) => {
    const app = await launch();
    const result = await app.client.invoke({ ...invoke, metadata: { mode } });
    expect('status' in result.response && result.response.status?.state).toBe(
      TaskState.TASK_STATE_FAILED,
    );
    expect('artifacts' in result.response && result.response.artifacts).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(
      'metadata' in result.response && result.response.metadata?.[EXTENSION_URI],
    ).toMatchObject({ code: 'OUTPUT_CONTRACT_VIOLATION', contractId: id });
  });
  test('SSE delivers complete atomic output with correct task correlation', async () => {
    const app = await launch();
    const events = [];
    for await (const event of app.client.stream({ ...invoke, metadata: { mode: 'stream' } }))
      events.push(event);
    expect(events[0]?.kind).toBe('companion');
    expect(events.at(-1)).toMatchObject({
      kind: 'result',
      result: { payload: { present: true, value: { count: 7 } } },
    });
    const failed = [];
    for await (const event of app.client.stream({ ...invoke, metadata: { mode: 'after-success' } }))
      failed.push(event);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      kind: 'result',
      result: { response: { artifacts: [], status: { state: TaskState.TASK_STATE_FAILED } } },
    });
  });
  test('SSE Message, omission, interruption and sanitized failure lifecycle', async () => {
    const app = await launch();
    for (const mode of ['message', 'finish', 'continue', 'stream-throw']) {
      const events = [];
      for await (const event of app.client.stream({ ...invoke, metadata: { mode } }))
        events.push(event);
      expect(events.at(-1)?.kind).toBe('result');
      const last = events.at(-1)!;
      if (last.kind !== 'result') throw new Error('Expected result.');
      if (mode === 'message' || mode === 'finish') expect(last.result.payload?.present).toBe(true);
      else expect(last.result.payload).toBeUndefined();
      if (mode === 'stream-throw') {
        expect(events).toHaveLength(2);
        expect(JSON.stringify(events)).not.toContain('secret');
      }
    }
    const none = await launch('none', 'none');
    const events = [];
    for await (const event of none.client.stream({ contractId: id })) events.push(event);
    expect(events.at(-1)).toMatchObject({
      kind: 'result',
      result: { payload: { present: false }, response: { artifacts: [] } },
    });
  });
  test('input-required context persists in official TaskStore and cannot change', async () => {
    const app = await launch();
    const initial = await app.client.invoke({ ...invoke, metadata: { mode: 'continue' } });
    if (!('status' in initial.response)) throw new Error('Expected Task');
    expect(initial.response.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    const continued = await app.client.invoke({ ...invoke, taskId: initial.response.id });
    expect(continued.payload).toMatchObject({ present: true, value: { count: 7 } });
    const again = await raw(
      app.url,
      SendMessageRequest.toJSON(app.client.prepare({ ...invoke, taskId: initial.response.id })),
    );
    expect(again.error?.code).toBe(-32602);
    expect(app.calls()).toBe(2);
  });
  test('CancelTask aborts cooperative execution and publishes correlated canceled status', async () => {
    const app = await launch();
    const pending = app.client.invoke({ ...invoke, metadata: { mode: 'wait' } });
    await vi.waitFor(() => expect(app.contexts).toHaveLength(1));
    const taskId = app.contexts[0]!.taskId;
    await vi.waitFor(async () =>
      expect(
        (await app.client.client.getTask(GetTaskRequest.fromJSON({ id: taskId }))).status?.state,
      ).toBe(TaskState.TASK_STATE_WORKING),
    );
    const canceled = await app.client.client.cancelTask(CancelTaskRequest.fromJSON({ id: taskId }));
    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect((await pending).response).toMatchObject({
      status: { state: TaskState.TASK_STATE_CANCELED },
      artifacts: [],
    });
    expect(app.signals[0]?.aborted).toBe(true);
  });
  test('application signal hook failures stay sanitized and cause zero business calls', async () => {
    const app = await launch();
    const result = await app.client.invoke(invoke, {
      serviceParameters: { 'X-Signal-Fail': 'yes' },
    });
    expect(result.response).toMatchObject({
      status: { state: TaskState.TASK_STATE_FAILED },
      artifacts: [],
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(app.calls()).toBe(0);
  });
  test('execution deadline closes an unfinished task without successful artifacts', async () => {
    const app = await launch('required', 'required', false, [json, text], 40);
    const result = await app.client.invoke({ ...invoke, metadata: { mode: 'wait' } });
    expect(result.response).toMatchObject({
      status: { state: TaskState.TASK_STATE_FAILED },
      artifacts: [],
    });
    expect(app.signals[0]?.aborted).toBe(true);
  });
  test('schemaless JSON scalar/array/empty carriers and root-null refusal', async () => {
    const app = await launch('required', 'required', false, [
      { id: 'json', mediaType: 'application/json' },
    ]);
    for (const value of [false, 0, '', [], {}, [null], { nested: null }]) {
      expect(
        (await app.client.invoke({ ...invoke, input: { representationId: 'json', value } })).payload
          ?.present,
      ).toBe(true);
      expect(app.contexts.at(-1)!.userMessage.parts[0]!.content?.value).toEqual(value);
    }
    await expect(
      app.client.invoke({ ...invoke, input: { representationId: 'json', value: null } }),
    ).rejects.toBeInstanceOf(ContractError);
    expect(app.calls()).toBe(7);
  });
  test('continuation cannot change negotiation or activation; history is unchanged on refusal', async () => {
    const app = await launch();
    const initial = await app.client.invoke({ ...invoke, metadata: { mode: 'continue' } });
    if (!('id' in initial.response)) throw new Error('Expected Task.');
    const taskId = initial.response.id;
    const before = await app.client.client.getTask(GetTaskRequest.fromJSON({ id: taskId }));
    const changed = await raw(
      app.url,
      SendMessageRequest.toJSON(
        app.client.prepare({ ...invoke, taskId, acceptedOutputRepresentationIds: ['text'] }),
      ),
    );
    expect(changed.error?.code).toBe(-32602);
    const baseline = await raw(
      app.url,
      { message: { messageId: 'later', taskId, role: 'ROLE_USER', parts: [{ text: 'continue' }] } },
      false,
    );
    expect(baseline.error?.code).toBe(-32602);
    expect(
      (await app.client.client.getTask(GetTaskRequest.fromJSON({ id: taskId }))).history,
    ).toEqual(before.history);
    expect(app.calls()).toBe(1);
    const canceled = await app.client.client.cancelTask(CancelTaskRequest.fromJSON({ id: taskId }));
    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
  });
  test('concurrent continuation is refused before history writes or a second execution', async () => {
    const app = await launch();
    const initial = await app.client.invoke({ ...invoke, metadata: { mode: 'continue' } });
    if (!('id' in initial.response)) throw new Error('Expected Task.');
    const taskId = initial.response.id;
    const pending = app.client.invoke(
      { ...invoke, taskId, metadata: { mode: 'wait' } },
      { signal: AbortSignal.timeout(2000) },
    );
    await vi.waitFor(() => expect(app.calls()).toBe(2));
    const before = await app.client.client.getTask(GetTaskRequest.fromJSON({ id: taskId }));
    const rejected = await raw(
      app.url,
      SendMessageRequest.toJSON(app.client.prepare({ ...invoke, taskId })),
    );
    expect(rejected.error?.code).toBe(-32602);
    expect(app.calls()).toBe(2);
    expect(
      (await app.client.client.getTask(GetTaskRequest.fromJSON({ id: taskId }))).history,
    ).toEqual(before.history);
    await app.client.client.cancelTask(CancelTaskRequest.fromJSON({ id: taskId }));
    expect((await pending).response).toMatchObject({
      status: { state: TaskState.TASK_STATE_CANCELED },
    });
  });
  test('missing continuation Task preserves the existing A2A not-found error', async () => {
    const app = await launch();
    const result = await raw(
      app.url,
      SendMessageRequest.toJSON(
        app.client.prepare({ ...invoke, taskId: '00000000-0000-4000-8000-000000000001' }),
      ),
    );
    expect(result.error?.code).toBe(-32001);
    expect(app.calls()).toBe(0);
  });
  test('unknown selection, bad metadata scopes, presence and media refusals reach no business', async () => {
    const app = await launch();
    const request = SendMessageRequest.toJSON(app.client.prepare(invoke)) as {
      message: Record<string, unknown>;
      metadata: Record<string, unknown>;
    };
    const variants = [
      {
        ...request,
        metadata: {
          [EXTENSION_URI]: { contractId: 'urn:unknown:1', inputRepresentationId: 'json' },
        },
      },
      {
        ...request,
        metadata: { [EXTENSION_URI]: { contractId: id, inputRepresentationId: 'missing' } },
      },
      {
        ...request,
        metadata: {
          [EXTENSION_URI]: {
            contractId: id,
            inputRepresentationId: 'json',
            acceptedOutputRepresentationIds: ['missing'],
          },
        },
      },
      { ...request, message: { ...request.message, metadata: request.metadata } },
      { ...request, message: { ...request.message, parts: [{ text: 'companion' }] } },
      { ...request, configuration: { acceptedOutputModes: ['image/png'] } },
      { ...request, configuration: { acceptedOutputModes: [7] } },
      { ...request, configuration: { returnImmediately: true } },
    ];
    for (const variant of variants) expect((await raw(app.url, variant)).error).toBeDefined();
    expect(app.calls()).toBe(0);
  });
  test('abort propagates to cooperative business execution and late output is discarded', async () => {
    const app = await launch();
    const controller = new AbortController();
    const rejected = expect(
      app.client.invoke({ ...invoke, metadata: { mode: 'wait' } }, { signal: controller.signal }),
    ).rejects.toThrow();
    try {
      // Assert execution has started before testing in-flight cancellation on slower runners.
      await vi.waitFor(() => expect(app.signals).toHaveLength(1), { timeout: 2000 });
      controller.abort();
      await rejected;
      await vi.waitFor(() => expect(app.signals[0]?.aborted).toBe(true), { timeout: 2000 });
    } finally {
      controller.abort();
    }
    expect(app.calls()).toBe(1);
  });
});

describe('nonconforming peer raw guards', () => {
  test.each([
    { text: 7 },
    { text: '', data: {} },
    { data: null },
    {},
    { raw: '?' },
    { url: 'relative' },
    { text: '', mediaType: 7 },
    { text: '', filename: 7 },
    { text: '', metadata: [] },
  ])('raw request refuses normalized carrier %j', (part) => {
    expect(() =>
      guardJsonRpcRequest({
        method: 'SendMessage',
        params: { message: { role: 'ROLE_USER', messageId: 'one', parts: [part] } },
      }),
    ).toThrow();
  });
  test('raw response JSON and SSE guards reject before codec normalization', async () => {
    const envelopes = [
      JSON.stringify({ result: { message: { parts: [{ text: 7 }] } } }),
      'data: ' + JSON.stringify({ result: { message: { parts: [{ data: null }] } } }) + '\n\n',
    ];
    for (const [index, body] of envelopes.entries()) {
      const guarded = guardResponseFetch(() =>
        Promise.resolve(
          new Response(body, {
            headers: { 'Content-Type': index === 0 ? 'application/json' : 'text/event-stream' },
          }),
        ),
      );
      const response = await guarded('http://local');
      await expect(response.text()).rejects.toThrow();
    }
  });
  test.each([
    'schema',
    'missing-echo',
    'wrong-echo',
    'missing-primary',
    'two-primaries',
    'raw-coercion',
    'raw-null',
    'wrong-role',
  ])('independent HTTP peer rejection: %s', async (mode) => {
    const good = await launch();
    const card = AgentCard.fromJSON(AgentCard.toJSON(good.contractServer.card));
    const peer = express();
    peer.use(express.json());
    peer.get('/.well-known/agent-card.json', (_req, res) => {
      res.json(AgentCard.toJSON(card));
    });
    peer.post('/rpc', (req, res) => {
      const primary = {
        data: mode === 'schema' ? { count: -1 } : { count: 2 },
        mediaType: 'application/json',
        metadata: {
          [EXTENSION_URI]: {
            role: 'primary',
            contractId: id,
            direction: 'output',
            representationId: 'json',
          },
        },
      };
      const message: Record<string, unknown> = {
        messageId: 'fake',
        contextId: 'fake',
        role: mode === 'wrong-role' ? 'ROLE_USER' : 'ROLE_AGENT',
        parts:
          mode === 'two-primaries'
            ? [primary, primary]
            : mode === 'missing-primary'
              ? [{ text: 'companion' }]
              : mode === 'raw-coercion'
                ? [{ text: 7 }]
                : mode === 'raw-null'
                  ? [{ data: null }]
                  : [primary],
      };
      if (mode !== 'missing-echo')
        message.metadata = {
          [EXTENSION_URI]: {
            contractId: mode === 'wrong-echo' ? 'urn:other:1' : id,
            outputRepresentationId: 'json',
          },
        };
      res.json({ jsonrpc: '2.0', id: (req.body as { id: unknown }).id, result: { message } });
    });
    const server = peer.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No address.');
    const url = `http://127.0.0.1:${address.port}`;
    card.supportedInterfaces[0]!.url = url + '/rpc';
    cleanup.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    });
    const client = await discoverContractClient(url);
    await expect(client.invoke(invoke)).rejects.toThrow();
  });
  test('client accepts a peer choice of any representation satisfying both negotiation mechanisms', async () => {
    const app = await launch();
    const peer = Object.create(app.client.client) as typeof app.client.client;
    peer.sendMessage = () =>
      Promise.resolve(
        Message.fromJSON({
          messageId: 'peer',
          contextId: 'peer',
          role: 'ROLE_AGENT',
          parts: [
            {
              text: '',
              mediaType: 'text/plain',
              metadata: {
                [EXTENSION_URI]: {
                  contractId: id,
                  direction: 'output',
                  representationId: 'text',
                  role: 'primary',
                },
              },
            },
          ],
          metadata: { [EXTENSION_URI]: { contractId: id, outputRepresentationId: 'text' } },
        }),
      );
    const client = await createContractClient(peer);
    expect((await client.invoke(invoke)).payload).toMatchObject({
      present: true,
      representationId: 'text',
      value: '',
    });
    await expect(
      client.invoke({ ...invoke, acceptedOutputRepresentationIds: ['json'] }),
    ).rejects.toThrow();
    await expect(
      client.invoke({
        ...invoke,
        configuration: {
          acceptedOutputModes: ['application/json'],
          returnImmediately: false,
          taskPushNotificationConfig: undefined,
        },
      }),
    ).rejects.toThrow();
  });
  test('SSE reader cancellation and byte limits release upstream resources', async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(': keepalive\n\n'));
      },
      cancel() {
        canceled = true;
      },
    });
    const guarded = guardResponseFetch(() =>
      Promise.resolve(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })),
    );
    const reader = (await guarded('http://local')).body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(canceled).toBe(true);
    const huge = guardResponseFetch(() =>
      Promise.resolve(
        new Response('x'.repeat(262145), { headers: { 'Content-Type': 'application/json' } }),
      ),
    );
    await expect((await huge('http://local')).text()).rejects.toThrow();
    const unfinished = guardResponseFetch(() =>
      Promise.resolve(
        new Response('data: {}', { headers: { 'Content-Type': 'text/event-stream' } }),
      ),
    );
    await expect((await unfinished('http://local')).text()).rejects.toThrow();
  });
  test('client independently refuses invalid output from a peer', async () => {
    const app = await launch();
    const dishonest = Object.create(app.client.client) as typeof app.client.client;
    dishonest.sendMessage = () =>
      Promise.resolve(
        Task.fromJSON({
          id: 'fake',
          contextId: 'fake',
          status: { state: 'TASK_STATE_COMPLETED' },
          artifacts: [
            {
              artifactId: 'one',
              parts: [
                {
                  data: { count: -1 },
                  mediaType: 'application/json',
                  metadata: {
                    [EXTENSION_URI]: {
                      role: 'primary',
                      contractId: id,
                      direction: 'output',
                      representationId: 'json',
                    },
                  },
                },
              ],
            },
          ],
          metadata: { [EXTENSION_URI]: { contractId: id, outputRepresentationId: 'json' } },
        }),
      );
    const client: ContractClient = await createContractClient(dishonest);
    await expect(client.invoke(invoke)).rejects.toBeInstanceOf(ContractError);
  });
});

test('explicit resolver discovery and prepared server catalog use the same validated profile', async () => {
  const running = await launch('required', 'required', false, [json, text], 30000, true);
  const client = await discoverContractClient(running.url, {
    resolver: createContractResolver(),
    signal: AbortSignal.timeout(5000),
  });
  const result = await client.invoke({
    contractId: id,
    input: { representationId: 'json', value: { count: 2 } },
    acceptedOutputRepresentationIds: ['json'],
  });
  expect(result.payload?.present).toBe(true);
});

test('a noncooperating cancellation callback cannot hold the protocol response open', async () => {
  const app = await launch('required', 'required', false, [json, text], 200, false, true);
  const iterator = app.client.stream({ ...invoke, metadata: { mode: 'wait' } });
  const first = await iterator.next();
  if (first.done || first.value.kind !== 'companion' || first.value.event.payload?.$case !== 'task')
    throw new Error('Expected initial Task.');
  const taskId = first.value.event.payload.value.id;
  const start = performance.now();
  const canceled = await app.client.client.cancelTask(CancelTaskRequest.fromJSON({ id: taskId }));
  expect(performance.now() - start).toBeLessThan(1500);
  expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
  for await (const event of iterator)
    if (event.kind === 'result')
      expect(event.result.response).toMatchObject({
        status: { state: TaskState.TASK_STATE_CANCELED },
        artifacts: [],
      });
});

test('closing owned client/server validation shuts down safely and refuses subsequent contracted work', async () => {
  const app = await launch();
  await app.client.close();
  await expect(app.client.invoke(invoke)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
  await app.contractServer.close();
  const response = await raw(app.url, SendMessageRequest.toJSON(app.client.prepare(invoke)));
  expect(response.error?.code).toBe(-32602);
  expect(app.calls()).toBe(0);
});

test('pre-aborted application signals reject before execution with no orphan rejected promise', async () => {
  const app = await launch();
  const result = await app.client.invoke(invoke, { serviceParameters: { 'X-Pre-Abort': 'yes' } });
  expect(result.response).toMatchObject({
    status: { state: TaskState.TASK_STATE_FAILED },
    artifacts: [],
  });
  expect(app.calls()).toBe(0);
});

test('synchronously throwing application executors are sanitized without orphan race rejections', async () => {
  const app = await launch('required', 'required', false, [json, text], 30000, false, false, true);
  const result = await app.client.invoke(invoke);
  expect(result.response).toMatchObject({
    status: { state: TaskState.TASK_STATE_FAILED },
    artifacts: [],
  });
  expect(JSON.stringify(result)).not.toContain('secret');
});

test('active application execution capacity is bounded and released after cancellation', async () => {
  const app = await launch(
    'required',
    'required',
    false,
    [json, text],
    30000,
    false,
    false,
    false,
    1,
  );
  const iterator = app.client.stream({ ...invoke, metadata: { mode: 'wait' } });
  const first = await iterator.next();
  if (first.done || first.value.kind !== 'companion' || first.value.event.payload?.$case !== 'task')
    throw new Error('Expected initial Task.');
  const refused = await app.client.invoke(invoke);
  expect(refused.response).toMatchObject({
    status: { state: TaskState.TASK_STATE_FAILED },
    artifacts: [],
  });
  expect(app.calls()).toBe(1);
  await app.client.client.cancelTask(
    CancelTaskRequest.fromJSON({ id: first.value.event.payload.value.id }),
  );
  for await (const event of iterator)
    if (event.kind === 'result')
      expect(event.result.response).toMatchObject({
        status: { state: TaskState.TASK_STATE_CANCELED },
      });
  expect((await app.client.invoke(invoke)).payload).toMatchObject({ present: true });
  expect(app.calls()).toBe(2);
});

test.each([0, 5, 1.5])(
  'invalid active-execution limit %s is rejected during construction',
  async (limit) => {
    await expect(
      launch('required', 'required', false, [json, text], 30000, false, false, false, limit),
    ).rejects.toThrow(TypeError);
  },
);
