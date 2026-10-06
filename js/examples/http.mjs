import assert from 'node:assert/strict';
import { once } from 'node:events';

import { AgentCard, Artifact, SendMessageRequest, Task, TaskState } from '@a2a-js/sdk';
import { toJsonRpcError } from '@a2a-js/sdk/errors';
import { AgentEvent, InMemoryTaskStore, ServerCallContext } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { discoverContractClient } from 'a2a-schema-contract/client';
import { EXTENSION_URI } from 'a2a-schema-contract/core';
import { createContractServer, outputArtifact } from 'a2a-schema-contract/server';
import express from 'express';

const contractId = 'https://contracts.example.org/double/1.0';
const representation = {
  id: 'json',
  mediaType: 'application/json',
  schema: {
    mediaType: 'application/schema+json',
    dialect: 'https://json-schema.org/draft/2020-12/schema',
    inline: {
      type: 'object',
      required: ['count'],
      properties: { count: { type: 'integer', minimum: 0, maximum: 100 } },
      additionalProperties: false,
    },
  },
};
let calls = 0;
const serverAdapter = createContractServer({
  card: AgentCard.fromJSON({
    name: 'Double',
    description: 'Deterministic contract quickstart',
    version: '1.0',
    supportedInterfaces: [{ url: '', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: { streaming: true },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [],
  }),
  catalog: {
    contracts: [
      {
        id: contractId,
        input: { presence: 'required', representations: [representation] },
        output: { presence: 'required', representations: [representation] },
      },
    ],
  },
  taskStore: new InMemoryTaskStore(),
  required: true,
  signal: (context) => context.state.get('disconnect'),
  executor: {
    async execute(context, bus) {
      calls++;
      const execution = serverAdapter.execution(context);
      assert.ok(execution.input.present);
      const count = execution.input.value.count;
      const invalid = context.request.metadata?.invalidOutput;
      const artifact = outputArtifact(execution, { count: invalid ? -1 : count * 2 });
      bus.publish(
        AgentEvent.task(
          Task.fromJSON({
            id: context.taskId,
            contextId: context.contextId,
            status: { state: 'TASK_STATE_COMPLETED' },
            artifacts: [Artifact.toJSON(artifact)],
          }),
        ),
      );
    },
    async cancelTask() {},
  },
});
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(
  '/.well-known/agent-card.json',
  agentCardHandler({ agentCardProvider: serverAdapter.handler }),
);
app.use('/rpc', (req, res, next) => {
  try {
    serverAdapter.guard(req.body);
    next();
  } catch (error) {
    res.json({ jsonrpc: '2.0', id: req.body?.id ?? null, error: toJsonRpcError(error) });
  }
});
app.use('/rpc', (req, res, next) => {
  const controller = new AbortController();
  res.once('close', () => controller.abort());
  return jsonRpcHandler({
    requestHandler: serverAdapter.handler,
    userBuilder: UserBuilder.noAuthentication,
    contextBuilder: (options) =>
      new ServerCallContext({
        requestedExtensions: options.extensions,
        requestedVersion: options.requestedVersion,
        user: options.user,
        state: new Map([
          ['disconnect', controller.signal],
          ['headers', options.headers],
        ]),
      }),
  })(req, res, next);
});
const server = app.listen(0, '127.0.0.1');
try {
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  serverAdapter.card.supportedInterfaces[0].url = url + '/rpc';
  const client = await discoverContractClient(url);
  assert.equal(
    client.catalog.getContract(contractId).input.representations[0].schema.inline.type,
    'object',
  );
  const invocation = { contractId, input: { representationId: 'json', value: { count: 4 } } };
  const result = await client.invoke(invocation, { signal: AbortSignal.timeout(5000) });
  assert.deepEqual(result.payload.value, { count: 8 });
  await assert.rejects(
    client.invoke({ ...invocation, input: { representationId: 'json', value: { count: -1 } } }),
  );
  assert.equal(calls, 1);
  // Bypass local validation and prove server refusal before business execution.
  const wire = SendMessageRequest.toJSON(client.prepare(invocation));
  wire.message.parts[0].data = { count: -1 };
  const rejected = await fetch(url + '/rpc', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'A2A-Version': '1.0',
      'A2A-Extensions': EXTENSION_URI,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: wire }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal((await rejected.json()).error.code, -32602);
  assert.equal(calls, 1);
  const failed = await client.invoke({ ...invocation, metadata: { invalidOutput: true } });
  assert.equal(failed.response.status.state, TaskState.TASK_STATE_FAILED);
  assert.deepEqual(failed.response.artifacts, []);
  const events = [];
  for await (const event of client.stream(invocation, { signal: AbortSignal.timeout(5000) }))
    events.push(event);
  assert.deepEqual(events.at(-1).result.payload.value, { count: 8 });
  console.log(
    JSON.stringify({
      result: 'PASS',
      transport: 'A2A 1.0 JSON-RPC/HTTP + SSE',
      checks: [
        'discovery-and-schema-exposure',
        'validated-roundtrip',
        'local-no-dispatch',
        'wire-zero-execution',
        'invalid-output-no-artifact',
        'atomic-SSE-result',
      ],
      executions: calls,
    }),
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
