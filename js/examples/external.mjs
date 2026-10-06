import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { AgentCard, Artifact, Task, TaskState, SendMessageRequest } from '@a2a-js/sdk';
import { AgentEvent, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { toJsonRpcError } from '@a2a-js/sdk/errors';
import { EXTENSION_URI, JSON_SCHEMA_DIALECT } from '@shashikanth-gs/a2a-schema-contract/core';
import { createContractResolver } from '@shashikanth-gs/a2a-schema-contract/resolver';
import { createContractServer, outputArtifact } from '@shashikanth-gs/a2a-schema-contract/server';
import { discoverContractClient } from '@shashikanth-gs/a2a-schema-contract/client';

// This certificate/key is a public local-test fixture. It is never a production credential.
const fixture = process.argv[2] ?? fileURLToPath(new URL('../test/fixtures/tls/', import.meta.url));
const ca = await readFile(path.join(fixture, 'cert.pem'));
const key = await readFile(path.join(fixture, 'key.pem'));
const resources = new Map();
let retrievals = 0;
const https = createServer({ cert: ca, key }, (req, res) => {
  retrievals++;
  const resource = resources.get(req.url);
  if (!resource) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': resource.type });
  res.end(resource.bytes);
});
https.listen(0, '127.0.0.1');
await once(https, 'listening');
const origin = `https://catalog.test:${https.address().port}`;
const digest = (bytes) => ({
  algorithm: 'sha-256',
  value: createHash('sha256').update(bytes).digest('base64'),
});
const publish = (url, value, type = 'application/schema+json') => {
  const bytes = JSON.stringify(value);
  resources.set(url, { bytes, type });
  return digest(bytes);
};
const rootIntegrity = publish('/root', { $ref: 'child#/$defs/payload' });
const childIntegrity = publish('/child', {
  $defs: {
    payload: {
      type: 'object',
      required: ['count'],
      properties: { count: { type: 'integer', minimum: 0, maximum: 100 } },
      additionalProperties: false,
    },
  },
});
const contractId = 'urn:example:external-double:1';
const representation = {
  id: 'json',
  mediaType: 'application/json',
  schema: {
    mediaType: 'application/schema+json',
    dialect: JSON_SCHEMA_DIALECT,
    uri: origin + '/root',
    integrity: rootIntegrity,
  },
};
const source = {
  contracts: [
    {
      id: contractId,
      input: { presence: 'required', representations: [representation] },
      output: { presence: 'required', representations: [representation] },
    },
  ],
};
const catalogIntegrity = publish('/catalog', source, 'application/json');
const resolverOptions = {
  allowedOrigins: [origin],
  ca,
  lookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
  allowAddress: (address, hostname) => address === '127.0.0.1' && hostname === 'catalog.test',
  resourceIntegrity: { [origin + '/child']: childIntegrity },
};
let http;
try {
  const prepared = await createContractResolver(resolverOptions).resolveCatalog(source, {
    origin: 'local',
  });
  let calls = 0;
  const adapter = createContractServer({
    card: AgentCard.fromJSON({
      name: 'External double',
      description: 'Secure resolution quickstart',
      version: '1.0',
      supportedInterfaces: [{ url: '', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      capabilities: { streaming: true },
      defaultInputModes: ['application/json'],
      defaultOutputModes: ['application/json'],
      skills: [],
    }),
    catalog: prepared,
    taskStore: new InMemoryTaskStore(),
    required: true,
    executor: {
      async execute(context, bus) {
        calls++;
        const execution = adapter.execution(context);
        const count = execution.input.value.count;
        // Invalid output is staged by the adapter and can never become a successful artifact.
        const output = context.request.metadata?.invalidOutput
          ? { count: -1 }
          : { count: count * 2 };
        bus.publish(
          AgentEvent.task(
            Task.fromJSON({
              id: context.taskId,
              contextId: context.contextId,
              status: { state: 'TASK_STATE_COMPLETED' },
              artifacts: [Artifact.toJSON(outputArtifact(execution, output))],
            }),
          ),
        );
      },
      async cancelTask() {},
    },
  });
  adapter.card.capabilities.extensions.find((e) => e.uri === EXTENSION_URI).params = {
    catalog: {
      uri: origin + '/catalog',
      mediaType: 'application/json',
      integrity: catalogIntegrity,
    },
  };
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: adapter.handler }));
  app.use('/rpc', (req, res, next) => {
    try {
      adapter.guard(req.body);
      next();
    } catch (error) {
      res.json({ jsonrpc: '2.0', id: req.body?.id ?? null, error: toJsonRpcError(error) });
    }
  });
  app.use(
    '/rpc',
    jsonRpcHandler({ requestHandler: adapter.handler, userBuilder: UserBuilder.noAuthentication }),
  );
  http = app.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const url = `http://127.0.0.1:${http.address().port}`;
  adapter.card.supportedInterfaces[0].url = url + '/rpc';
  const resolver = createContractResolver(resolverOptions);
  await assert.rejects(discoverContractClient(url), { code: 'SCHEMA_UNAVAILABLE' });
  const client = await discoverContractClient(url, { resolver, signal: AbortSignal.timeout(5000) });
  assert.equal(client.catalog.contracts[0].input.representations[0].schema.uri, origin + '/root');
  const before = retrievals;
  const invocation = { contractId, input: { representationId: 'json', value: { count: 4 } } };
  assert.deepEqual((await client.invoke(invocation)).payload.value, { count: 8 });
  await assert.rejects(
    client.invoke({ ...invocation, input: { representationId: 'json', value: { count: -1 } } }),
  );
  assert.equal(calls, 1);
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
  });
  assert.equal((await rejected.json()).error.code, -32602);
  assert.equal(calls, 1);
  const failed = await client.invoke({ ...invocation, metadata: { invalidOutput: true } });
  assert.equal(failed.response.status.state, TaskState.TASK_STATE_FAILED);
  assert.deepEqual(failed.response.artifacts, []);
  const events = [];
  for await (const event of client.stream(invocation)) events.push(event);
  assert.deepEqual(events.at(-1).result.payload.value, { count: 8 });
  assert.equal(retrievals, before);
  const malicious = await discoverContractClient(url, {
    resolver,
    fetchImpl: async (input, init) => {
      const response = await fetch(input, init);
      if (!init?.method || init.method === 'GET') return response;
      const data = await response.json();
      data.result.task.artifacts[0].parts[0].data = { count: -1 };
      return Response.json(data);
    },
  });
  await assert.rejects(malicious.invoke(invocation), { code: 'INSTANCE_INVALID' });
  console.log(
    JSON.stringify({
      result: 'PASS',
      retrievals,
      executions: calls,
      checks: [
        'pinned-external-catalog',
        'pinned-root-and-transitive-schema',
        'prepared-server-and-discovered-client',
        'validated-HTTP-roundtrip',
        'invalid-input-zero-execution',
        'invalid-output-no-artifact',
        'atomic-SSE-result',
        'no-request-time-retrieval',
        'independent-client-peer-refusal',
        'external-opt-in-required',
      ],
    }),
  );
} finally {
  if (http) {
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  }
  https.closeAllConnections();
  await new Promise((resolve) => https.close(resolve));
}
