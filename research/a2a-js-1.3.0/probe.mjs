import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import express from 'express';
import { AgentCard, Message, Part, Role, Task, TaskState } from '@a2a-js/sdk';
import { ClientFactory, JsonRpcTransportFactory, ServiceParameters, withA2AExtensions } from '@a2a-js/sdk/client';
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { ContentTypeNotSupportedError, toJsonRpcError } from '@a2a-js/sdk/errors';

const uri = 'https://w3id.org/a2a-schema-contract/draft/0.1';
const contractId = 'https://contracts.example.org/probe/1.0';
const results = [];
async function check(id, run, finding) {
  await run();
  results.push({ id, result: 'PASS', finding });
  console.log(`PASS ${id}`);
}
const primary = { contractId, direction: 'input', representationId: 'json', role: 'primary' };
const invocation = { contractId, inputRepresentationId: 'json' };
const echo = { contractId, outputRepresentationId: 'json' };
const samples = [
  ['object', { nested: null, list: [true, 1, 'x'] }], ['empty-object', {}],
  ['array', [null, false, 0]], ['empty-array', []], ['string', 'value'],
  ['empty-string-data', ''], ['number', 42], ['zero', 0], ['boolean', false],
];
for (const [name, value] of samples) {
  await check(`codec-${name}`, () => {
    const part = Part.fromJSON({ data: value, mediaType: 'application/json' });
    assert.equal(part.content?.$case, 'data');
    assert.deepEqual(Part.toJSON(part).data, value);
  }, 'JSON value retained by public Part codecs.');
}
await check('codec-root-null-loss', () => {
  assert.equal(Part.fromJSON({ data: null, mediaType: 'application/json' }).content, undefined);
  const outgoing = Part.toJSON({ content: { $case: 'data', value: null }, mediaType: 'application/json', filename: '', metadata: undefined });
  assert.equal(outgoing.data, null);
  assert.equal(Part.fromJSON(outgoing).content, undefined);
}, 'Root data:null is serialized but decoded as absent; adapter must reject it.');
await check('codec-invalid-content-normalization', () => {
  assert.equal(Part.fromJSON({ text: 7 }).content.value, '7');
  assert.equal(Part.fromJSON({ text: 'x', data: {} }).content.$case, 'text');
  assert.equal(Part.fromJSON({}).content, undefined);
}, 'Codecs coerce text and choose the first content member; raw-wire guards are required.');
await check('codec-empty-text-media-metadata', () => {
  const wire = { text: '', mediaType: 'Text/Plain; Charset="UTF-8"', metadata: { [uri]: primary } };
  assert.deepEqual(Part.toJSON(Part.fromJSON(wire)), wire);
}, 'Empty text, media parameters and namespaced metadata survive.');

const received = [];
const store = new InMemoryTaskStore();
let executorCalls = 0;
const executor = {
  async execute(context, bus) {
    executorCalls++;
    received.push(context);
    const mode = context.request.metadata?.probe;
    if (context.context.requestedExtensions?.includes(uri)) context.context.addActivatedExtension(uri);
    if (mode === 'throw') throw new Error('probe-private-sentinel');
    if (mode === 'message') {
      bus.publish(AgentEvent.message(Message.fromJSON({
        messageId: crypto.randomUUID(), role: 'ROLE_AGENT', contextId: context.contextId,
        parts: [Part.toJSON(context.userMessage.parts[0])], metadata: { [uri]: echo },
      })));
      return;
    }
    const task = Task.fromJSON({ id: context.taskId, contextId: context.contextId,
      status: { state: mode === 'stream' ? 'TASK_STATE_WORKING' : 'TASK_STATE_COMPLETED' },
      metadata: { [uri]: mode === 'none' ? { contractId } : echo },
      ...(mode === 'none' ? {} : { artifacts: [{ artifactId: 'result', parts: context.userMessage.parts.map(Part.toJSON), metadata: { [uri]: echo } }] }),
    });
    bus.publish(AgentEvent.task(task));
    if (mode === 'stream') bus.publish(AgentEvent.statusUpdate({
      taskId: context.taskId, contextId: context.contextId,
      status: { state: TaskState.TASK_STATE_COMPLETED, timestamp: undefined, message: undefined },
      metadata: { [uri]: echo },
    }));
  },
  async cancelTask() { throw new Error('Cancellation is not exercised by this compatibility probe.'); },
};
const card = AgentCard.fromJSON({ name: 'Published SDK probe', description: 'Compatibility probe', version: '1.0',
  supportedInterfaces: [{ url: '', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  capabilities: { streaming: true, extensions: [{ uri, required: false, params: { catalog: { inline: { contracts: [{ id: contractId, input: { presence: 'none' }, output: { presence: 'none' } }] } } } }] },
  defaultInputModes: ['application/json', 'text/plain'], defaultOutputModes: ['application/json', 'text/plain'], skills: [],
});
const handler = new DefaultRequestHandler(card, store, executor);
const app = express();
app.use(express.json({ limit: '64kb' }));
app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: handler }));
app.use('/rpc', jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;
card.supportedInterfaces[0].url = `${baseUrl}/rpc`;
const options = { serviceParameters: ServiceParameters.create(withA2AExtensions(uri)), signal: AbortSignal.timeout(5000) };
function request(part, mode = 'task') {
  return { message: Message.fromJSON({ messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [part], metadata: { [uri]: invocation } }), metadata: { probe: mode } };
}
try {
  let client;
  await check('http-discovery-public-client', async () => {
    client = await new ClientFactory({ transports: [new JsonRpcTransportFactory()] }).createFromUrl(baseUrl);
    assert.equal(client.protocolVersion, '1.0');
    assert.equal((await client.getAgentCard()).capabilities.extensions[0].uri, uri);
  }, 'Public factory discovers the advertised 1.0 JSON-RPC interface and params.');
  for (const [name, value] of samples) {
    await check(`http-${name}`, async () => {
      const result = await client.sendMessage(request({ data: value, mediaType: 'application/json', metadata: { [uri]: primary } }), options);
      assert.equal(result.status.state, TaskState.TASK_STATE_COMPLETED);
      assert.deepEqual(result.artifacts[0].parts[0].content.value, value);
      assert.deepEqual(received.at(-1).userMessage.metadata[uri], invocation);
      assert.deepEqual(result.artifacts[0].parts[0].metadata[uri], primary);
      assert.deepEqual(result.metadata[uri], echo);
    }, 'Object/scalar/array value and metadata retain their identity across real HTTP.');
  }
  await check('http-root-null-loss', async () => {
    const response = await fetch(`${baseUrl}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ data: null, mediaType: 'application/json' }] }, metadata: { probe: 'none' } } }),
    });
    assert.equal((await response.json()).result.task.status.state, 'TASK_STATE_COMPLETED');
    assert.equal(received.at(-1).userMessage.parts[0].content, undefined);
  }, 'Invalid content-less Part reaches executor after null decoding; SDK is not a validity boundary.');
  await check('http-empty-text-parameters-message-result', async () => {
    const result = await client.sendMessage(request({ text: '', mediaType: 'Text/Plain; Charset="UTF-8"' }, 'message'), options);
    assert.equal(result.role, Role.ROLE_AGENT);
    assert.equal(result.parts[0].content.value, '');
    assert.equal(result.parts[0].mediaType, 'Text/Plain; Charset="UTF-8"');
    assert.deepEqual(result.metadata[uri], echo);
  }, 'Standalone Message response supported with exact media spelling and result metadata.');
  await check('http-no-output-task-storage', async () => {
    const result = await client.sendMessage(request({ text: 'trigger', mediaType: 'text/plain' }, 'none'), options);
    assert.equal(result.status.state, TaskState.TASK_STATE_COMPLETED);
    assert.deepEqual(result.artifacts, []);
    assert.deepEqual(result.metadata[uri], { contractId });
    const stored = await client.getTask({ id: result.id }, { signal: AbortSignal.timeout(5000) });
    assert.equal(stored.id, result.id);
    assert.deepEqual(stored.metadata[uri], { contractId });
  }, 'Completed Task with no Artifact and result echo survives public task storage/getTask.');
  await check('http-activation-context-isolation', async () => {
    const active = { serviceParameters: { ...options.serviceParameters, 'X-Probe': 'context-ok' }, signal: AbortSignal.timeout(5000) };
    await Promise.all([
      client.sendMessage(request({ text: 'a' }, 'none'), active),
      client.sendMessage(request({ text: 'b' }, 'none'), { signal: AbortSignal.timeout(5000) }),
    ]);
    const contexts = received.slice(-2).map(r => r.context);
    assert.equal(contexts.filter(c => c.activatedExtensions?.includes(uri)).length, 1);
    assert.equal(contexts.filter(c => c.state.get('headers')['x-probe'] === 'context-ok').length, 1);
  }, 'Activation and application headers are per call; SDK requires explicit addActivatedExtension.');
  await check('http-required-activation-before-executor', async () => {
    card.capabilities.extensions[0].required = true;
    const before = executorCalls;
    try { await assert.rejects(client.sendMessage(request({ text: 'trigger' }, 'none')), error => error.envelopeCode === -32008); }
    finally { card.capabilities.extensions[0].required = false; }
    assert.equal(executorCalls, before);
  }, 'Required extension missing produces existing A2A -32008 before executor call.');
  await check('http-stream-public-events', async () => {
    const events = [];
    for await (const event of client.sendMessageStream(request({ data: { ok: true }, mediaType: 'application/json' }, 'stream'), options)) events.push(event);
    assert.equal(events[0].payload.$case, 'task');
    assert.equal(events.at(-1).payload.$case, 'statusUpdate');
    assert.deepEqual(events.at(-1).payload.value.metadata[uri], echo);
  }, 'SSE emits initial Task then status update with namespaced metadata.');
  await check('executor-throw-detail-loss-and-disclosure', async () => {
    const log = console.error;
    let logged = false;
    console.error = () => { logged = true; };
    let result;
    try { result = await client.sendMessage(request({ text: 'trigger' }, 'throw'), options); }
    finally { console.error = log; }
    assert.equal(result.status.state, TaskState.TASK_STATE_FAILED);
    assert.ok(result.status.message.parts[0].content.value.includes('probe-private-sentinel'));
    assert.ok(logged);
  }, 'SDK catches executor exceptions, logs them and echoes their text; adapter must sanitize and publish its own failed Task.');
  await check('error-info-namespaced-string-detail', () => {
    const detail = { code: 'REPRESENTATION_NOT_SUPPORTED', contractId, direction: 'output' };
    const mapped = toJsonRpcError(new ContentTypeNotSupportedError({ message: 'Unsupported representation.', metadata: { [uri]: JSON.stringify(detail) } }));
    assert.equal(mapped.code, -32005);
    assert.deepEqual(JSON.parse(mapped.data[0].metadata[uri]), detail);
  }, 'Existing ErrorInfo.metadata supports a namespaced serialized draft detail without inventing a protobuf type.');
} finally {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
const packageJson = JSON.parse(await readFile(new URL('node_modules/@a2a-js/sdk/package.json', import.meta.url), 'utf8'));
const report = {
  task: 'SDK-001', date: '2026-10-06', runtime: process.version, platform: `${process.platform}/${process.arch}`,
  sdk: packageJson.version, lockSha256: createHash('sha256').update(await readFile(new URL('package-lock.json', import.meta.url))).digest('hex'),
  passed: results.length, results,
  exclusions: ['No extension boundary implementation/conformance claim.', 'No gRPC/REST/legacy/browser/CJS/cancellation guarantee.'],
};
const reportName = `report-node${process.versions.node.split('.')[0]}.json`;
await writeFile(new URL(reportName, import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(`All ${results.length} probes passed; ${reportName}`);
