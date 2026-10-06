import { once } from 'node:events';
import { readFile } from 'node:fs/promises';

import { AgentCard, Artifact, Task, TaskState } from '@a2a-js/sdk';
import { AgentEvent, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import express from 'express';
import { expect, test } from 'vitest';

import { discoverContractClient } from '../src/client/index.js';
import {
  createContractExtension,
  describeContracts,
  EXTENSION_URI,
  JSON_SCHEMA_DIALECT,
  parseCatalog,
  selectInvocation,
  type SimpleInvocation,
} from '../src/core/index.js';
import { createContractServer, outputArtifact } from '../src/server/index.js';

const id = 'urn:example:flight-search:1';
const json = {
  id: 'json',
  mediaType: 'application/json',
  schema: {
    mediaType: 'application/schema+json',
    dialect: JSON_SCHEMA_DIALECT,
    inline: {
      type: 'object',
      required: ['origin'],
      properties: { origin: { type: 'string' } },
      additionalProperties: false,
    },
  },
};
const text = { id: 'text', mediaType: 'text/plain' };
const source = () => ({
  contracts: [
    {
      id,
      skillIds: ['flight-search', 'travel'],
      input: { presence: 'required', representations: [json] },
      output: { presence: 'required', representations: [json] },
    },
  ],
});

test('skill discovery retains many-to-many, stale, unmapped and unsupported candidates', () => {
  const data = source();
  data.contracts.push({
    ...data.contracts[0]!,
    id: 'urn:example:flight-search:2',
    skillIds: ['flight-search', 'missing'],
    input: {
      presence: 'required',
      representations: [{ ...json, mediaType: 'application/vendor+json' }],
    },
  });
  const unassociated = {
    id: 'urn:example:unassociated:1',
    input: { presence: 'none' },
    output: { presence: 'none' },
  };
  const catalog = parseCatalog({
    contracts: [
      ...data.contracts,
      unassociated,
      { ...unassociated, id: 'urn:example:empty:1', skillIds: [] },
    ],
  });
  const view = describeContracts(catalog, [
    { id: 'flight-search', name: 'Flights', description: 'Search flights' },
    { id: 'travel' },
    { id: 'unused' },
  ]);
  expect(view.skills.map((s) => s.contracts.length)).toEqual([2, 1, 0]);
  expect(view.staleAssociations).toEqual([
    { contractId: 'urn:example:flight-search:2', skillId: 'missing' },
  ]);
  expect(view.unassociated).toHaveLength(2);
  expect(view.skills[0]!.contracts[1]!.input[0]).toMatchObject({
    supported: false,
    diagnostic: 'UNSUPPORTED_MEDIA_TYPE',
  });
  expect(Object.isFrozen(view.skills[0]!.contracts)).toBe(true);
  expect(describeContracts(catalog).skills).toEqual([]);
});
test.each([
  {},
  [null],
  [{}],
  [{ id: 4 }],
  [{ id: '' }],
  [{ id: 's', name: 3 }],
  [{ id: 's', description: false }],
])('malformed skill advertisement refuses without invocation: %j', (skills) => {
  expect(() => describeContracts(parseCatalog(source()), skills)).toThrowError(/INVALID_STRUCTURE/);
});
test('duplicate skill identifiers are refused', () => {
  expect(() => describeContracts(parseCatalog(source()), [{ id: 's' }, { id: 's' }])).toThrowError(
    /DUPLICATE_IDENTIFIER/,
  );
});

test('schema access is immutable, offline and independent of validator compilation', () => {
  const data = structuredClone(source());
  const catalog = parseCatalog(data);
  const schema = catalog.schema(id, 'input', 'json')!;
  expect(schema.descriptor).toEqual(json.schema);
  expect(schema.documents[0]!.uri).toBe(schema.entry);
  expect(schema.documents[0]!.value).toEqual(json.schema.inline);
  data.contracts[0]!.input.representations[0]!.schema.inline.required.push('mutated');
  expect(schema.documents[0]!.value).toEqual({ ...json.schema.inline, required: ['origin'] });
  expect(Object.isFrozen(schema.documents[0]!.value)).toBe(true);
  const boolean = parseCatalog({
    contracts: [
      {
        id,
        input: {
          presence: 'required',
          representations: [{ ...json, schema: { ...json.schema, inline: false } }],
        },
        output: { presence: 'none' },
      },
    ],
  });
  expect(boolean.schema(id, 'input', 'json')!.documents[0]!.value).toBe(false);
  const schemaless = parseCatalog({
    contracts: [
      {
        id,
        input: { presence: 'required', representations: [text] },
        output: { presence: 'none' },
      },
    ],
  });
  expect(schemaless.schema(id, 'input', 'text')).toBeUndefined();
  expect(() => catalog.schema(id, 'bad' as 'input', 'json')).toThrowError(/INVALID_STRUCTURE/);
  expect(() => catalog.schema(id, 'input', 'missing')).toThrowError(/REPRESENTATION_NOT_SUPPORTED/);
  for (const [schema, code] of [
    [{ ...json.schema, dialect: 'urn:unsupported:1' }, 'UNSUPPORTED_DIALECT'],
    [{ ...json.schema, mediaType: 'text/plain' }, 'UNSUPPORTED_MEDIA_TYPE'],
    [
      {
        mediaType: 'application/schema+json',
        dialect: JSON_SCHEMA_DIALECT,
        uri: 'https://example.org/schema',
      },
      'SCHEMA_UNAVAILABLE',
    ],
  ] as const) {
    const parsed = parseCatalog({
      contracts: [
        {
          id,
          input: { presence: 'required', representations: [{ ...json, schema }] },
          output: { presence: 'none' },
        },
      ],
    });
    expect(() => parsed.schema(id, 'input', 'json')).toThrowError(new RegExp(code));
  }
});

test('compact selection emits explicit identifiers and never mutates application input', () => {
  const catalog = parseCatalog(source());
  const input = { origin: 'BLR' };
  expect(selectInvocation(catalog, { contractId: id, input })).toEqual({
    contractId: id,
    input: { representationId: 'json', value: input },
    acceptedOutputRepresentationIds: ['json'],
  });
  expect(
    selectInvocation(catalog, {
      contractId: id,
      input,
      inputRepresentationId: 'json',
      acceptedOutputRepresentationIds: ['json'],
    }).input!.value,
  ).toEqual(input);
  expect(input).toEqual({ origin: 'BLR' });
});
test.each([
  [{}, 'INVALID_STRUCTURE'],
  [null, 'INVALID_STRUCTURE'],
  [{ contractId: id }, 'PAYLOAD_PRESENCE_VIOLATION'],
  [{ contractId: id, input: {} }, 'INSTANCE_INVALID'],
  [{ contractId: id, input: { origin: 'BLR' }, inputRepresentationId: 4 }, 'INVALID_STRUCTURE'],
  [
    { contractId: id, input: { origin: 'BLR' }, acceptedOutputRepresentationIds: [] },
    'INVALID_STRUCTURE',
  ],
  [
    { contractId: id, input: { origin: 'BLR' }, acceptedOutputRepresentationIds: 'json' },
    'INVALID_STRUCTURE',
  ],
  [
    { contractId: id, input: { origin: 'BLR' }, acceptedOutputRepresentationIds: [3] },
    'INVALID_STRUCTURE',
  ],
  [
    { contractId: id, input: { origin: 'BLR' }, acceptedOutputRepresentationIds: ['json', 'json'] },
    'INVALID_STRUCTURE',
  ],
  [
    { contractId: id, input: { origin: 'BLR' }, acceptedOutputRepresentationIds: ['missing'] },
    'REPRESENTATION_NOT_SUPPORTED',
  ],
])('compact selection rejects invalid options before dispatch: %j', (options, code) => {
  expect(() => selectInvocation(parseCatalog(source()), options as SimpleInvocation)).toThrowError(
    new RegExp(code),
  );
});
test('compact selection handles presence and reports ambiguous or unsupported alternatives', () => {
  const none = parseCatalog({
    contracts: [{ id, input: { presence: 'none' }, output: { presence: 'none' } }],
  });
  expect(selectInvocation(none, { contractId: id })).toEqual({ contractId: id });
  expect(() => selectInvocation(none, { contractId: id, input: null })).toThrowError(
    /PAYLOAD_PRESENCE_VIOLATION/,
  );
  expect(() =>
    selectInvocation(none, { contractId: id, inputRepresentationId: 'json' }),
  ).toThrowError(/INVALID_METADATA/);
  expect(() =>
    selectInvocation(none, { contractId: id, acceptedOutputRepresentationIds: ['json'] }),
  ).toThrowError(/INVALID_METADATA/);
  const optional = parseCatalog({
    contracts: [
      {
        id,
        input: { presence: 'optional', representations: [text] },
        output: { presence: 'optional', representations: [text] },
      },
    ],
  });
  expect(selectInvocation(optional, { contractId: id })).toEqual({
    contractId: id,
    acceptedOutputRepresentationIds: ['text'],
  });
  expect(selectInvocation(optional, { contractId: id, input: '' }).input!.value).toBe('');
  for (const direction of ['input', 'output'] as const) {
    const data = source();
    const ambiguous = parseCatalog({
      contracts: [
        {
          ...data.contracts[0],
          [direction]: { presence: 'required', representations: [json, text] },
        },
      ],
    });
    expect(() =>
      selectInvocation(ambiguous, { contractId: id, input: { origin: 'BLR' } }),
    ).toThrowError(/AMBIGUOUS_SELECTION/);
    const unsupported = parseCatalog({
      contracts: [
        {
          ...data.contracts[0],
          [direction]: {
            presence: 'required',
            representations: [{ ...json, mediaType: 'application/vendor+json' }],
          },
        },
      ],
    });
    expect(() =>
      selectInvocation(unsupported, { contractId: id, input: { origin: 'BLR' } }),
    ).toThrowError(/REPRESENTATION_NOT_SUPPORTED/);
  }
});
test('portable advertisement validates options and requires external preparation provenance', () => {
  const catalog = parseCatalog(source());
  expect(createContractExtension(catalog)).toMatchObject({
    uri: EXTENSION_URI,
    required: false,
    params: { catalog: { inline: source() } },
  });
  expect(
    createContractExtension(catalog, { required: true, catalogDelivery: 'inline' }).required,
  ).toBe(true);
  expect(() =>
    createContractExtension(catalog, { required: 'yes' as unknown as boolean }),
  ).toThrowError(/INVALID_STRUCTURE/);
  expect(() =>
    createContractExtension(catalog, { catalogDelivery: 'bad' as 'inline' }),
  ).toThrowError(/INVALID_STRUCTURE/);
  expect(() => createContractExtension(catalog, { catalogDelivery: 'external' })).toThrowError(
    /SCHEMA_UNAVAILABLE/,
  );
});

test('ordinary HTTP client discovers skills and invokes compactly with zero dispatch on ambiguity', async () => {
  let calls = 0;
  const data = source();
  const adapter = createContractServer({
    card: AgentCard.fromJSON({
      name: 'Flights',
      description: 'Deterministic search',
      version: '1',
      capabilities: {},
      skills: [{ id: 'flight-search', name: 'Flights', description: 'Search', tags: ['travel'] }],
      supportedInterfaces: [{ url: '', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      defaultInputModes: ['application/json'],
      defaultOutputModes: ['application/json'],
    }),
    catalog: {
      contracts: [
        ...data.contracts,
        {
          ...data.contracts[0],
          id: 'urn:example:ambiguous:1',
          input: { presence: 'required', representations: [json, text] },
        },
      ],
    },
    taskStore: new InMemoryTaskStore(),
    required: true,
    executor: {
      execute(context, bus) {
        calls++;
        bus.publish(
          AgentEvent.task(
            Task.fromJSON({
              id: context.taskId,
              contextId: context.contextId,
              status: { state: 'TASK_STATE_COMPLETED' },
              artifacts: [
                Artifact.toJSON(outputArtifact(adapter.execution(context), { origin: 'BLR' })),
              ],
            }),
          ),
        );
        return Promise.resolve();
      },
      async cancelTask() {},
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: adapter.handler }));
  app.use('/rpc', (req, _res, next) => {
    adapter.guard(req.body);
    next();
  });
  app.use(
    '/rpc',
    jsonRpcHandler({ requestHandler: adapter.handler, userBuilder: UserBuilder.noAuthentication }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('address');
  const url = `http://127.0.0.1:${address.port}`;
  adapter.card.supportedInterfaces[0]!.url = url + '/rpc';
  const client = await discoverContractClient(url);
  try {
    expect((await client.describe()).skills[0]!.contracts).toHaveLength(2);
    expect(client.catalog.schema(id, 'input', 'json')!.descriptor).toEqual(json.schema);
    await expect(
      client.invokeContract({ contractId: 'urn:example:ambiguous:1', input: { origin: 'BLR' } }),
    ).rejects.toMatchObject({ code: 'AMBIGUOUS_SELECTION' });
    await expect(client.invokeContract({ contractId: id, input: {} })).rejects.toMatchObject({
      code: 'INSTANCE_INVALID',
    });
    expect(calls).toBe(0);
    const result = await client.invokeContract(
      { contractId: id, input: { origin: 'BLR' } },
      { signal: AbortSignal.timeout(5000) },
    );
    expect(result.payload?.present && result.payload.value).toEqual({ origin: 'BLR' });
    expect((result.response as Task).status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(calls).toBe(1);
    const request = JSON.parse(
      await readFile(new URL('../../tests/binding/request.json', import.meta.url), 'utf8'),
    ) as { params: { message: { metadata?: unknown } } };
    const post = (body: unknown) =>
      fetch(url + '/rpc', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'A2A-Version': '1.0',
          'A2A-Extensions': EXTENSION_URI,
        },
        body: JSON.stringify(body),
      });
    expect(((await (await post(request)).json()) as { result: unknown }).result).toBeDefined();
    expect(calls).toBe(2);
    request.params.message.metadata = { [EXTENSION_URI]: { contractId: id } };
    expect(((await (await post(request)).json()) as { error: { code: number } }).error.code).toBe(
      -32602,
    );
    expect(calls).toBe(2);
    const response = JSON.parse(
      await readFile(new URL('../../tests/binding/response.json', import.meta.url), 'utf8'),
    ) as { result: { task: { metadata: unknown } } };
    const independent = await discoverContractClient(url, {
      fetchImpl: (input, init) => {
        if (init?.method !== 'POST') return fetch(input, init);
        const request = JSON.parse(init.body as string) as { id: unknown };
        return Promise.resolve(Response.json({ ...response, id: request.id }));
      },
    });
    try {
      expect(
        (await independent.invokeContract({ contractId: id, input: { origin: 'BLR' } })).payload
          ?.present,
      ).toBe(true);
      response.result.task.metadata = {};
      await expect(
        independent.invokeContract({ contractId: id, input: { origin: 'BLR' } }),
      ).rejects.toMatchObject({ code: 'INVALID_METADATA' });
      const failed = JSON.parse(
        await readFile(new URL('../../tests/binding/failure.json', import.meta.url), 'utf8'),
      ) as typeof response;
      response.result.task = failed.result.task;
      const failure = await independent.invokeContract({
        contractId: id,
        input: { origin: 'BLR' },
      });
      expect(failure.payload).toBeUndefined();
      expect(failure.response).toMatchObject({
        status: { state: TaskState.TASK_STATE_FAILED },
        artifacts: [],
        metadata: { [EXTENSION_URI]: { code: 'OUTPUT_CONTRACT_VIOLATION' } },
      });
    } finally {
      await independent.close();
    }
    const getter = {
      contractId: id,
      get input() {
        throw new Error('getter executed');
      },
    };
    await expect(client.invokeContract(getter)).rejects.toMatchObject({ code: 'NON_JSON_VALUE' });
    let captured: unknown;
    let activation = '';
    const composed = await discoverContractClient(url, {
      fetchImpl: async (input, init) => {
        if (init?.method === 'POST') {
          captured = JSON.parse(init.body as string) as unknown;
          activation = new Headers(init.headers).get('A2A-Extensions') ?? '';
        }
        return fetch(input, init);
      },
    });
    const other = 'https://example.org/extension/trace/v1';
    try {
      await composed.invokeContract(
        { contractId: id, input: { origin: 'BLR' }, metadata: { [other]: { trace: true } } },
        { serviceParameters: { 'A2A-Extensions': other } },
      );
      expect(activation).toContain(other);
      expect(activation).toContain(EXTENSION_URI);
      expect(captured).toMatchObject({
        params: { metadata: { [other]: { trace: true }, [EXTENSION_URI]: { contractId: id } } },
      });
    } finally {
      await composed.close();
    }
  } finally {
    await client.close();
    await adapter.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
