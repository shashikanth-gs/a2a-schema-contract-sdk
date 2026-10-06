import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { JSON_SCHEMA_DIALECT, parseCatalog } from 'a2a-schema-contract/core';
import { createValidationSession } from 'a2a-schema-contract/operations';
import { createContractResolver } from 'a2a-schema-contract/resolver';

const id = 'urn:benchmark:1';
const schema = {
  type: 'object',
  required: ['count'],
  properties: { count: { type: 'integer', minimum: 0, maximum: 100 } },
  additionalProperties: false,
};
const input = {
  presence: 'required',
  representations: [
    {
      id: 'json',
      mediaType: 'application/json',
      schema: {
        mediaType: 'application/schema+json',
        dialect: JSON_SCHEMA_DIALECT,
        inline: schema,
      },
    },
  ],
};
const source = { contracts: [{ id, input, output: { presence: 'none' } }] };
const samples = async (count, work) => {
  const values = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    await work();
    values.push(performance.now() - start);
  }
  values.sort((a, b) => a - b);
  return { samples: count, medianMs: values[Math.floor(count / 2)], maxMs: values.at(-1) };
};
const catalog = parseCatalog(source);
const coreCold = await samples(10, () => {
  const selected = parseCatalog(source).select(id, 'input', 'json');
  selected.validate({ count: 2 });
});
const selected = catalog.select(id, 'input', 'json');
const coreWarm = await samples(10, () => {
  for (let i = 0; i < 1000; i++) selected.validate({ count: 2 });
});
const session = createValidationSession(catalog);
let isolated;
try {
  isolated = await samples(5, async () => {
    assert.deepEqual(
      await session.run('validate', {
        contractId: id,
        direction: 'input',
        representationId: 'json',
        value: { count: 2 },
      }),
      { count: 2 },
    );
    assert.equal(session.active, 0);
  });
} finally {
  await session.close();
}
const ca = await readFile(path.join(process.argv[2], 'cert.pem'));
const key = await readFile(path.join(process.argv[2], 'key.pem'));
let requests = 0;
const bytes = Buffer.from(JSON.stringify(schema));
const server = createServer({ cert: ca, key }, (_req, res) => {
  requests++;
  res.writeHead(200, { 'Content-Type': 'application/schema+json' });
  res.end(bytes);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `https://catalog.test:${server.address().port}`;
const policy = {
  allowedOrigins: [origin],
  ca,
  lookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
  allowAddress: (address, hostname) => address === '127.0.0.1' && hostname === 'catalog.test',
};
const external = structuredClone(source);
external.contracts[0].input.representations[0].schema = {
  mediaType: 'application/schema+json',
  dialect: JSON_SCHEMA_DIALECT,
  uri: origin + '/schema',
  integrity: { algorithm: 'sha-256', value: createHash('sha256').update(bytes).digest('base64') },
};
let resolverCold, resolverWarm;
try {
  resolverCold = await samples(5, () => createContractResolver(policy).resolveCatalog(external));
  const resolver = createContractResolver(policy);
  await resolver.resolveCatalog(external);
  const before = requests;
  resolverWarm = await samples(5, () => resolver.resolveCatalog(external));
  assert.equal(requests, before);
  resolver.clearCache();
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
// Generous smoke ceilings include worker startup on shared hosted runners. The retained medians
// are the release baseline; same-environment investigations trigger at >3x median, not across OSs.
for (const result of [isolated, resolverCold, resolverWarm]) assert.ok(result.maxMs < 2000);
console.log(
  JSON.stringify({
    result: 'PASS',
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    workload:
      'Object with one bounded integer; 10 cold core compilations, 10 x 1000 warm validations, five fresh workers and five cold/cache-warm pinned HTTPS preparations.',
    coreCold,
    coreWarm: { ...coreWarm, validationsPerSample: 1000 },
    isolated,
    resolverCold,
    resolverWarm,
    regression: {
      absoluteWorkerAndResolverCeilingMs: 2000,
      investigateSameEnvironmentMedianMultiplier: 3,
    },
    workerReuse:
      'Each isolated call starts a new worker; warm refers to compiled synchronous core or resolver representation-byte cache.',
  }),
);
