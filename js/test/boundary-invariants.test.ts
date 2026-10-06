import { expect, test } from 'vitest';
import { AgentEvent } from '@a2a-js/sdk/server';
import { Message, Task, TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import { EXTENSION_URI, JSON_SCHEMA_DIALECT, parseCatalog } from '../src/core/index.js';
import { dispatchOperation } from '../src/operations/worker.js';
import { encodeEvents, decodeEvents, validateEvents } from '../src/server/index.js';
import { prepareRequest } from '../src/client/index.js';
import type { WireEvent } from '../src/server/index.js';

const id = 'urn:boundary-invariants:1';
const context = { origin: 'remote' as const };
const representation = {
  id: 'json',
  mediaType: 'application/json',
  schema: {
    mediaType: 'application/schema+json',
    dialect: JSON_SCHEMA_DIALECT,
    inline: {
      type: 'object',
      required: ['count'],
      properties: { count: { type: 'integer', minimum: 0, maximum: 100 } },
      additionalProperties: false,
    },
  },
};
const program = {
  contracts: [
    {
      id,
      input: { presence: 'required' as const, representations: [representation] },
      output: {
        presence: 'required' as const,
        representations: [representation, { id: 'text', mediaType: 'text/plain' }],
      },
    },
  ],
};
const primary = (count: number, direction = 'input') => ({
  data: { count },
  mediaType: 'application/json',
  metadata: {
    [EXTENSION_URI]: { contractId: id, direction, representationId: 'json', role: 'primary' },
  },
});
const request = {
  message: { messageId: 'input', role: 'ROLE_USER', parts: [primary(2)] },
  metadata: {
    [EXTENSION_URI]: {
      contractId: id,
      inputRepresentationId: 'json',
      acceptedOutputRepresentationIds: ['json'],
    },
  },
};
const echo = { [EXTENSION_URI]: { contractId: id, outputRepresentationId: 'json' } };
const message = {
  messageId: 'result',
  contextId: 'context',
  role: 'ROLE_AGENT',
  parts: [primary(4, 'output')],
  metadata: echo,
};
const artifact = { artifactId: 'result', parts: [primary(4, 'output')] };
const task = {
  id: 'task',
  contextId: 'context',
  status: { state: 'TASK_STATE_COMPLETED' },
  artifacts: [artifact],
  metadata: echo,
};
const call = (operation: string, value: Record<string, unknown>) =>
  dispatchOperation(operation, value, program, context);

test('generated boundary mutations preserve independent arithmetic-schema and identity invariants', async () => {
  for (let seed = 0; seed < 24; seed++) {
    const count = seed % 2 ? -seed : seed + 101;
    const mutation = { ...request, message: { ...request.message, parts: [primary(count)] } };
    expect((await call('request', mutation)).code).toBe('INSTANCE_INVALID');
    const good = await call('request', {
      ...request,
      message: { ...request.message, parts: [primary(seed)] },
    });
    expect(good.value).toMatchObject({
      input: { present: true, value: { count: seed } },
      outputRepresentationId: 'json',
    });
    const badOutput = { ...message, parts: [primary(count, 'output')] };
    expect((await call('result', { request, response: badOutput })).code).toBe('INSTANCE_INVALID');
  }
  const prepared = await call('prepare', {
    contractId: id,
    input: { representationId: 'json', value: { count: 2 } },
    companions: [{ text: 'companion' }],
    metadata: { correlation: 'safe' },
  });
  expect(prepared.code).toBeUndefined();
  expect(prepared.value).toMatchObject({
    message: { parts: [primary(2), { text: 'companion' }] },
    metadata: { correlation: 'safe' },
  });
  const catalog = parseCatalog(program);
  expect(() =>
    prepareRequest(catalog, {
      contractId: id,
      input: { representationId: 'json', value: { count: 2 } },
      metadata: echo,
    }),
  ).toThrow();
  expect(
    (await call('request', { ...request, configuration: { acceptedOutputModes: ['image/png'] } }))
      .code,
  ).toBe('REPRESENTATION_NOT_SUPPORTED');
});
test('Message/Task result carriers, missing/conflicting echo and failure states obey the declared boundary', async () => {
  for (const response of [message, task])
    expect((await call('result', { request, response })).value).toMatchObject({
      present: true,
      value: { count: 4 },
    });
  expect(
    (await call('result', { request, response: message, outputRepresentationId: 'json' })).code,
  ).toBeUndefined();
  for (const response of [
    { ...message, role: 'ROLE_USER' },
    { ...message, metadata: {} },
    {
      ...message,
      metadata: { [EXTENSION_URI]: { contractId: 'urn:wrong:1', outputRepresentationId: 'json' } },
    },
    { ...message, parts: [primary(4, 'output'), primary(4, 'output')] },
    { ...message, parts: [{ text: 'unmarked companion' }] },
    { ...task, id: '' },
    { ...task, status: { state: 'TASK_STATE_WORKING' } },
    {
      ...task,
      artifacts: [{ ...artifact, metadata: { [EXTENSION_URI]: { contractId: 'urn:wrong:1' } } }],
    },
    { ...task, status: { state: 'TASK_STATE_FAILED' } },
    { ...task, artifacts: [] },
  ])
    expect((await call('result', { request, response })).code).toBeDefined();
  for (const state of [
    'TASK_STATE_FAILED',
    'TASK_STATE_CANCELED',
    'TASK_STATE_REJECTED',
    'TASK_STATE_INPUT_REQUIRED',
  ]) {
    const response = { ...task, status: { state }, artifacts: [] };
    expect((await call('result', { request, response })).code).toBeUndefined();
  }
  expect(
    (
      await call('result', {
        request,
        response: {
          ...task,
          status: { state: 'TASK_STATE_INPUT_REQUIRED' },
          artifacts: [],
          metadata: {},
        },
      })
    ).code,
  ).toBeDefined();
  expect((await call('not-an-operation', { request })).code).toBe('INVALID_STRUCTURE');
  expect((await call('result', { request, response: null })).code).toBe('RESOURCE_LIMIT');
  const none = {
    contracts: [
      { id, input: { presence: 'none' as const }, output: { presence: 'none' as const } },
    ],
  };
  const noInput = {
    message: { messageId: 'none', role: 'ROLE_USER', parts: [{ text: 'invoke' }] },
    metadata: { [EXTENSION_URI]: { contractId: id } },
  };
  expect(
    (await dispatchOperation('result', { request: noInput, response: message }, none, context))
      .code,
  ).toBeDefined();
  expect(
    (
      await dispatchOperation(
        'result',
        {
          request: noInput,
          response: { ...task, artifacts: [], metadata: { [EXTENSION_URI]: { contractId: id } } },
        },
        none,
        context,
      )
    ).value,
  ).toMatchObject({ present: false });
});
const working: WireEvent = {
  kind: 'task',
  data: { id: 'task', contextId: 'context', status: { state: 'TASK_STATE_WORKING' } },
};
const update: WireEvent = {
  kind: 'artifactUpdate',
  data: { taskId: 'task', contextId: 'context', artifact, lastChunk: true, append: false },
};
const completed: WireEvent = {
  kind: 'statusUpdate',
  data: { taskId: 'task', contextId: 'context', status: { state: 'TASK_STATE_COMPLETED' } },
};
const streamCall = (events: readonly WireEvent[], started = false) =>
  call('events', { request, events, context: { taskId: 'task', contextId: 'context' }, started });
test('atomic publication grammar rejects premature success and every event identity/race mutation', async () => {
  for (const events of [
    [{ kind: 'message', data: message }],
    [{ kind: 'task', data: task }],
    [working, update, completed],
  ] as WireEvent[][])
    expect((await streamCall(events)).code).toBeUndefined();
  const associated = { ...working, data: { ...(working.data as object), metadata: echo } };
  expect((await streamCall([associated, update, completed], true)).code).toBeUndefined();
  const failed = {
    ...completed,
    data: { ...(completed.data as object), status: { state: 'TASK_STATE_FAILED' } },
  };
  const needsInput = {
    ...completed,
    data: { ...(completed.data as object), status: { state: 'TASK_STATE_INPUT_REQUIRED' } },
  };
  expect((await streamCall([working, failed])).code).toBeUndefined();
  expect((await streamCall([working, needsInput])).value).toMatchObject([
    { kind: 'task' },
    { kind: 'statusUpdate', data: { metadata: echo } },
  ]);
  const cases: WireEvent[][] = [
    [],
    [completed],
    [working],
    [{ kind: 'message', data: message }, completed],
    [{ kind: 'message', data: { ...message, contextId: 'foreign' } }],
    [{ kind: 'message', data: { ...message, taskId: 'foreign' } }],
    [{ kind: 'task', data: { ...task, id: 'foreign' } }],
    [{ kind: 'task', data: { ...task, artifacts: [artifact, artifact] } }],
    [working, update, completed, completed],
    [working, working],
    [working, { ...update, data: { ...(update.data as object), taskId: 'foreign' } }, completed],
    [working, { ...update, data: { ...(update.data as object), append: true } }, completed],
    [working, { ...update, data: { ...(update.data as object), lastChunk: false } }, completed],
    [working, update, update, completed],
    [working, { ...completed, data: { taskId: 'task', contextId: 'context' } }],
    [working, update, needsInput],
    [working, update, failed],
    [
      {
        kind: 'task',
        data: { ...task, metadata: { [EXTENSION_URI]: { contractId: 'urn:wrong:1' } } },
      },
    ],
    [
      {
        kind: 'task',
        data: {
          ...task,
          artifacts: [
            { ...artifact, metadata: { [EXTENSION_URI]: { contractId: 'urn:wrong:1' } } },
          ],
        },
      },
    ],
    [
      working,
      {
        ...completed,
        data: { ...(completed.data as object), status: { state: 'TASK_STATE_COMPLETED', message } },
      },
    ],
  ];
  for (const events of cases) expect((await streamCall(events)).code).toBeDefined();
});
test('wire event serialization preserves all public event carriers and baseline grammar', () => {
  const events = [
    AgentEvent.task(Task.fromJSON(task)),
    AgentEvent.message(Message.fromJSON(message)),
    AgentEvent.artifactUpdate(TaskArtifactUpdateEvent.fromJSON(update.data)),
    AgentEvent.statusUpdate(TaskStatusUpdateEvent.fromJSON(completed.data)),
  ];
  expect(encodeEvents(decodeEvents(encodeEvents(events)))).toEqual(encodeEvents(events));
  const executionContext = {
    taskId: 'task',
    contextId: 'context',
  } as import('@a2a-js/sdk/server').RequestContext;
  expect(() =>
    validateEvents(executionContext, [events[0]!], parseCatalog(program), undefined, false),
  ).not.toThrow();
});
