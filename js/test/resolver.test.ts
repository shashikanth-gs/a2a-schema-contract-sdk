import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, type ServerResponse, type IncomingMessage } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  ContractError,
  EXTENSION_URI,
  JSON_SCHEMA_DIALECT,
  parseCatalog,
  type Integrity,
} from '../src/core/index.js';
import {
  createContractResolver,
  RESOLVER_LIMITS,
  type ResolverOptions,
} from '../src/resolver/index.js';
import { publicAddress } from '../src/resolver/policy.js';

const contractId = 'urn:example:external:1';
const ca = await readFile(new URL('./fixtures/tls/cert.pem', import.meta.url));
const key = await readFile(new URL('./fixtures/tls/key.pem', import.meta.url));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
function pin(bytes: string | Buffer, algorithm: Integrity['algorithm'] = 'sha-256'): Integrity {
  return {
    algorithm,
    value: createHash(algorithm.replace('-', '')).update(bytes).digest('base64'),
  };
}
function catalog(schema: unknown = { type: 'integer', minimum: 0 }) {
  return {
    contracts: [
      {
        id: contractId,
        input: {
          presence: 'required',
          representations: [
            {
              id: 'json',
              mediaType: 'application/json',
              schema: {
                mediaType: 'application/schema+json',
                dialect: JSON_SCHEMA_DIALECT,
                ...(typeof schema === 'string' ? { uri: schema } : { inline: schema }),
              },
            },
          ],
        },
        output: { presence: 'none' },
      },
    ],
  };
}
function external(uri: string, integrity?: Integrity) {
  return { catalog: { uri, mediaType: 'application/json', ...(integrity ? { integrity } : {}) } };
}
type Route = (req: IncomingMessage, res: ServerResponse) => void;
async function fixture() {
  const routes = new Map<string, Route>();
  const calls: { path: string; host: string; auth: string | undefined }[] = [];
  const server = createHttpsServer({ cert: ca, key }, (req, res) => {
    calls.push({ path: req.url!, host: req.headers.host!, auth: req.headers.authorization });
    const route = routes.get(req.url!);
    if (route) route(req, res);
    else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('Fixture address.');
  const origin = `https://catalog.test:${address.port}`;
  const other = `https://other.test:${address.port}`;
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  function json(path: string, value: unknown, type = 'application/schema+json') {
    const bytes = JSON.stringify(value);
    routes.set(path, (_req, res) => {
      res.writeHead(200, { 'Content-Type': type });
      res.end(bytes);
    });
    return bytes;
  }
  const dns = vi.fn(() => Promise.resolve([{ address: '127.0.0.1', family: 4 as const }]));
  const options: ResolverOptions = {
    ca,
    lookup: dns,
    allowAddress: (address, host) =>
      address === '127.0.0.1' && ['catalog.test', 'other.test'].includes(host),
    allowedOrigins: [origin, other],
  };
  return {
    routes,
    calls,
    origin,
    other,
    json,
    dns,
    options,
    resolver: (extra: ResolverOptions = {}) => createContractResolver({ ...options, ...extra }),
  };
}
function selected(
  value: Awaited<ReturnType<ReturnType<typeof createContractResolver>['resolveCatalog']>>,
) {
  return value.select(contractId, 'input', 'json');
}

describe('explicit external catalog/schema preparation', () => {
  test.each(['sha-256', 'sha-512'] as const)(
    'pins external catalog with %s and validates offline',
    async (algorithm) => {
      const f = await fixture();
      const bytes = f.json('/catalog', catalog(), 'application/json');
      const resolver = f.resolver();
      const source = external(f.origin + '/catalog', pin(bytes, algorithm));
      const prepared = await resolver.resolveExtension({
        uri: EXTENSION_URI,
        required: true,
        params: source,
      });
      expect(selected(prepared).validate(3)).toBe(3);
      expect(() => selected(prepared).validate(-1)).toThrow(
        expect.objectContaining({ code: 'INSTANCE_INVALID' }),
      );
      await resolver.resolveExtensionParams(source);
      expect(f.calls).toHaveLength(1);
      expect(resolver.cache.entries).toBe(1);
      expect(prepared.contracts).toEqual(catalog().contracts);
    },
  );
  test('external catalog requires pin or an exact administrator immutability promise', async () => {
    const f = await fixture();
    f.json('/catalog', catalog(), 'application/json');
    await expect(
      f.resolver().resolveExtensionParams(external(f.origin + '/catalog')),
    ).rejects.toMatchObject({ code: 'RESOLUTION_POLICY' });
    expect(f.calls).toHaveLength(0);
    const resolver = f.resolver({ immutableResources: [f.origin + '/catalog'] });
    const prepared = await resolver.resolveExtensionParams(external(f.origin + '/catalog'));
    expect(selected(prepared).validate(0)).toBe(0);
    await resolver.resolveExtensionParams(external(f.origin + '/catalog'));
    expect(f.calls).toHaveLength(1);
  });
  test('inline catalog and Boolean schema preserve descriptors without hidden I/O', async () => {
    const f = await fixture();
    const prepared = await f
      .resolver()
      .resolveExtensionParams({ catalog: { inline: catalog(false) } });
    expect(() => selected(prepared).validate(0)).toThrow(
      expect.objectContaining({ code: 'INSTANCE_INVALID' }),
    );
    expect(f.dns).not.toHaveBeenCalled();
    expect(() => selected(parseCatalog(catalog(f.origin + '/schema')))).toThrow(
      expect.objectContaining({ code: 'SCHEMA_UNAVAILABLE' }),
    );
  });
  test('document pointers, anchors, relative references and nested base IDs keep native semantics', async () => {
    const f = await fixture();
    f.json('/schemas/root', {
      $defs: {
        selected: { $anchor: 'value', $ref: 'nested/inner' },
        nested: { $id: 'nested/inner', $ref: 'count' },
      },
    });
    f.json('/schemas/nested/count', { type: 'integer', minimum: 5 });
    for (const fragment of ['#/$defs/selected', '#value']) {
      const value = await f
        .resolver()
        .resolveCatalog(catalog(f.origin + '/schemas/root' + fragment));
      expect(selected(value).validate(5)).toBe(5);
      expect(() => selected(value).validate(4)).toThrow();
    }
    expect(f.calls.map((c) => c.path)).toEqual([
      '/schemas/root',
      '/schemas/nested/count',
      '/schemas/root',
      '/schemas/nested/count',
    ]);
  });
  test('root $id and embedded resources prevent unnecessary retrieval', async () => {
    const f = await fixture();
    f.json('/schema', {
      $id: 'https://logical.test/root',
      $defs: { child: { $id: 'child', type: 'integer' } },
      $ref: 'child',
    });
    const prepared = await f.resolver().resolveCatalog(catalog(f.origin + '/schema'));
    expect(selected(prepared).validate(0)).toBe(0);
    expect(() => selected(prepared).validate('x')).toThrow();
    expect(f.calls).toHaveLength(1);
  });
  test('local recursive and dynamic references terminate on child instances', async () => {
    const f = await fixture();
    for (const schema of [
      { type: 'object', properties: { child: { $ref: '#' } }, additionalProperties: false },
      { $dynamicAnchor: 'node', type: 'object', properties: { child: { $dynamicRef: '#node' } } },
    ]) {
      f.json('/schema', schema);
      const prepared = await f.resolver().resolveCatalog(catalog(f.origin + '/schema'));
      expect(selected(prepared).validate({ child: { child: {} } })).toEqual({
        child: { child: {} },
      });
      expect(() => selected(prepared).validate({ child: 0 })).toThrow();
    }
  });
  test('external-catalog inline schemas need their own absolute base for relative dependencies', async () => {
    const f = await fixture();
    f.json('/count', { type: 'integer' });
    const bytes = f.json(
      '/catalog',
      catalog({ $id: f.origin + '/root', $ref: 'count' }),
      'application/json',
    );
    const prepared = await f
      .resolver()
      .resolveExtensionParams(external(f.origin + '/catalog', pin(bytes)));
    expect(selected(prepared).validate(1)).toBe(1);
  });
  test('references cannot turn annotation objects into uninspected assertion schemas', async () => {
    const f = await fixture();
    for (const schema of [
      { default: { pattern: '(a+)+' }, $ref: '#/default' },
      { examples: [{ unknownAssertion: true }], $ref: '#/examples/0' },
      { const: true, $ref: '#/const' },
    ]) {
      f.json('/schema', schema);
      await expect(
        f.resolver().resolveCatalog(catalog(f.origin + '/schema')),
      ).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
    }
    f.json('/schema', { $defs: { 'a/b~c': { const: 1 } }, $ref: '#/$defs/a~1b~0c' });
    expect(
      selected(await f.resolver().resolveCatalog(catalog(f.origin + '/schema'))).validate(1),
    ).toBe(1);
  });
  test('percent/space/hash pointer names and redirected document fragments remain valid', async () => {
    const f = await fixture();
    f.routes.set('/start', (_req, res) => {
      res.writeHead(302, { Location: '/final/root' });
      res.end();
    });
    f.json('/final/root', { $defs: { 'a%b #c': { const: 1 } } });
    expect(
      selected(
        await f.resolver().resolveCatalog(catalog(f.origin + '/start#/$defs/a%25b%20%23c')),
      ).validate(1),
    ).toBe(1);
  });
  test('environment proxy and insecure TLS settings cannot override the explicit connection policy', async () => {
    const f = await fixture();
    f.json('/schema', true);
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:1');
    vi.stubEnv('https_proxy', 'http://127.0.0.1:1');
    vi.stubEnv('NODE_USE_ENV_PROXY', '1');
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
    try {
      expect(
        selected(await f.resolver().resolveCatalog(catalog(f.origin + '/schema'))).validate(1),
      ).toBe(1);
      await expect(
        createContractResolver({ lookup: f.dns, allowAddress: () => true }).resolveCatalog(
          catalog(f.origin + '/schema'),
        ),
      ).rejects.toMatchObject({ code: 'SCHEMA_UNAVAILABLE' });
    } finally {
      vi.unstubAllEnvs();
    }
  });
  test('unresolved pointers and invalid documents fail before catalog exposure', async () => {
    const f = await fixture();
    f.json('/schema', { $defs: { value: true } });
    await expect(
      f.resolver().resolveCatalog(catalog(f.origin + '/schema#/missing')),
    ).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
    f.json('/schema', { unknownAssertion: true });
    await expect(f.resolver().resolveCatalog(catalog(f.origin + '/schema'))).rejects.toMatchObject({
      code: 'UNSUPPORTED_KEYWORD',
    });
  });
  test('unsupported alternatives remain visible with capability diagnostics', async () => {
    const f = await fixture();
    const source = catalog();
    const reps = source.contracts[0]!.input.representations;
    const generic = reps as unknown as Record<string, unknown>[];
    generic.push({
      id: 'bundle',
      mediaType: 'application/json',
      schema: {
        mediaType: 'application/zip',
        dialect: JSON_SCHEMA_DIALECT,
        bundle: { uri: f.origin + '/bundle', mediaType: 'application/zip' },
        entrypoint: 'root.json',
      },
    });
    generic.push({
      id: 'xml',
      mediaType: 'application/json',
      schema: { mediaType: 'application/xml', dialect: 'urn:xsd:1', uri: f.origin + '/xml' },
    });
    generic.push({
      id: 'media',
      mediaType: 'application/json',
      schema: { mediaType: 'text/plain', dialect: JSON_SCHEMA_DIALECT, inline: true },
    });
    const prepared = await f.resolver().resolveCatalog(source);
    expect(prepared.capabilities(contractId, 'input').map((c) => c.diagnostic)).toEqual([
      undefined,
      'SCHEMA_UNAVAILABLE',
      'UNSUPPORTED_DIALECT',
      'UNSUPPORTED_MEDIA_TYPE',
    ]);
    expect(f.calls).toHaveLength(0);
  });
});

describe('connection-bound address and redirect policy', () => {
  test.each([
    '0.0.0.0',
    '10.0.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '168.63.129.16',
    '172.16.0.1',
    '192.168.0.1',
    '100.100.100.200',
    '224.0.0.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '192.0.0.1',
    '192.88.99.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:8.8.8.8',
    '64:ff9b::a00:1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '2001:20::1',
    '2002:7f00:1::',
    '3fff::1',
    'garbage',
  ])('blocks special-use %s', (ip) => {
    expect(publicAddress(ip)).toBe(false);
  });
  test.each(['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888', '2606:4700:4700:0:0:0:0:1111'])(
    'recognizes global address %s',
    (ip) => {
      expect(publicAddress(ip)).toBe(true);
    },
  );
  test.each([
    'http://catalog.test/schema',
    'file:///etc/passwd',
    'ftp://catalog.test/schema',
    'https://user:secret@catalog.test/schema',
    'https://catalog.test./schema',
    'https://catalog.test/a\\b',
    'https://catalog.test/%xx',
    'https://catalog.test/latest',
    'https://catalog.test/\nsecret',
    'not-a-uri',
    'https://cátalog.test/schema',
  ])('rejects hostile URL %s before DNS', async (uri) => {
    const f = await fixture();
    await expect(f.resolver().resolveCatalog(catalog(uri))).rejects.toBeInstanceOf(ContractError);
    expect(f.dns).not.toHaveBeenCalled();
  });
  test.each([
    'https://2130706433/schema',
    'https://0x7f000001/schema',
    'https://0177.0.0.1/schema',
    'https://%31%32%37.0.0.1/schema',
    'https://[::ffff:127.0.0.1]/schema',
  ])('canonicalized host tricks cannot escape IP checks: %s', async (uri) => {
    await expect(createContractResolver().resolveCatalog(catalog(uri))).rejects.toMatchObject({
      code: 'RESOLUTION_POLICY',
    });
  });
  test('default policy rejects private and mixed DNS answers; trusted DNS failures are sanitized', async () => {
    const f = await fixture();
    await expect(
      f.resolver({ allowAddress: () => false }).resolveCatalog(catalog(f.origin + '/schema')),
    ).rejects.toMatchObject({ code: 'RESOLUTION_POLICY' });
    for (const lookup of [
      () => Promise.resolve([]),
      () =>
        Promise.resolve([
          { address: '8.8.8.8', family: 4 as const },
          { address: '127.0.0.1', family: 4 as const },
        ]),
      () => Promise.resolve([{ address: '127.0.0.1', family: 6 as const }]),
      () =>
        Promise.resolve(
          Array(33).fill({ address: '8.8.8.8', family: 4 }) as { address: string; family: 4 }[],
        ),
    ])
      await expect(
        f
          .resolver({ lookup, allowAddress: () => false })
          .resolveCatalog(catalog(f.origin + '/schema')),
      ).rejects.toMatchObject({ code: 'RESOLUTION_POLICY' });
    await expect(
      f
        .resolver({ lookup: () => Promise.reject(new Error('secret-dns')) })
        .resolveCatalog(catalog(f.origin + '/schema')),
    ).rejects.toThrow('Schema Contract rejected: SCHEMA_UNAVAILABLE.');
    expect(f.calls).toHaveLength(0);
  });
  test('system DNS still applies address policy without a custom lookup', async () => {
    await expect(
      createContractResolver().resolveCatalog(catalog('https://localhost/schema')),
    ).rejects.toMatchObject({ code: 'RESOLUTION_POLICY' });
  });
  test('connection uses the approved address once while preserving Host and original TLS identity', async () => {
    const f = await fixture();
    f.json('/schema', true);
    const prepared = await f.resolver().resolveCatalog(catalog(f.origin + '/schema'));
    expect(selected(prepared).validate(0)).toBe(0);
    expect(f.dns).toHaveBeenCalledExactlyOnceWith('catalog.test', expect.any(AbortSignal));
    expect(f.calls[0]!.host).toBe(new URL(f.origin).host);
    const unknown = f.origin.replace('catalog.test', 'wrong.test');
    await expect(
      f
        .resolver({ allowedOrigins: [unknown], allowAddress: () => true })
        .resolveCatalog(catalog(unknown + '/schema')),
    ).rejects.toMatchObject({ code: 'SCHEMA_UNAVAILABLE' });
    await expect(
      createContractResolver({ lookup: f.dns, allowAddress: () => true }).resolveCatalog(
        catalog(f.origin + '/schema'),
      ),
    ).rejects.toMatchObject({ code: 'SCHEMA_UNAVAILABLE' });
    expect(f.calls).toHaveLength(1);
  });
  test('literal IP connections also enforce TLS certificate identity', async () => {
    const f = await fixture();
    f.json('/schema', true);
    const uri = f.origin.replace('catalog.test', '127.0.0.1') + '/schema';
    const prepared = await createContractResolver({ ca, allowAddress: () => true }).resolveCatalog(
      catalog(uri),
    );
    expect(selected(prepared).validate(0)).toBe(0);
  });
  test('every redirect gets new DNS/IP/origin checks; rebinding cannot reuse an approved answer', async () => {
    const f = await fixture();
    f.routes.set('/start', (_req, res) => {
      res.writeHead(302, { Location: '/end' });
      res.end();
    });
    f.json('/end', true);
    f.dns
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
      .mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);
    await expect(f.resolver().resolveCatalog(catalog(f.origin + '/start'))).rejects.toMatchObject({
      code: 'RESOLUTION_POLICY',
    });
    expect(f.calls.map((c) => c.path)).toEqual(['/start']);
    f.routes.set('/start', (_req, res) => {
      res.writeHead(302, { Location: 'http://127.0.0.1/end' });
      res.end();
    });
    await expect(f.resolver().resolveCatalog(catalog(f.origin + '/start'))).rejects.toMatchObject({
      code: 'RESOLUTION_POLICY',
    });
    f.routes.set('/start', (_req, res) => {
      res.writeHead(302, { Location: f.other + '/end' });
      res.end();
    });
    await expect(
      f.resolver({ allowedOrigins: [f.origin] }).resolveCatalog(catalog(f.origin + '/start')),
    ).rejects.toMatchObject({ code: 'RESOLUTION_POLICY' });
  });
  test('redirects strip authorization permanently across origin changes and ignore response cookies', async () => {
    const f = await fixture();
    f.routes.set('/start', (_req, res) => {
      res.writeHead(302, { Location: '/same', 'Set-Cookie': 'secret=cookie' });
      res.end();
    });
    f.routes.set('/same', (_req, res) => {
      res.writeHead(307, { Location: f.other + '/other' });
      res.end();
    });
    f.routes.set('/other', (req, res) => {
      expect(req.headers.cookie).toBeUndefined();
      res.writeHead(308, { Location: f.origin + '/end' });
      res.end();
    });
    f.json('/end', true);
    await f
      .resolver({ authorization: { [f.origin]: 'Bearer tenant-a', [f.other]: 'Bearer other' } })
      .resolveCatalog(catalog(f.origin + '/start'));
    expect(f.calls.map((c) => c.auth)).toEqual([
      'Bearer tenant-a',
      'Bearer tenant-a',
      undefined,
      undefined,
    ]);
  });
  test('relative redirect final location sets schema base, and final bytes carry the digest', async () => {
    const f = await fixture();
    f.routes.set('/start', (_req, res) => {
      res.writeHead(303, { Location: '/final/root' });
      res.end('unhashed redirect body');
    });
    const bytes = f.json('/final/root', { $ref: 'child' });
    f.json('/final/child', { const: 4 });
    const source = catalog(f.origin + '/start');
    Object.assign(source.contracts[0]!.input.representations[0]!.schema, { integrity: pin(bytes) });
    expect(selected(await f.resolver().resolveCatalog(source)).validate(4)).toBe(4);
  });
  test('redirect loops, exhaustion, missing location and malformed locations fail deterministically', async () => {
    const f = await fixture();
    f.routes.set('/loop', (_req, res) => {
      res.writeHead(301, { Location: '/loop' });
      res.end();
    });
    await expect(f.resolver().resolveCatalog(catalog(f.origin + '/loop'))).rejects.toMatchObject({
      code: 'REFERENCE_CYCLE',
    });
    await expect(
      f.resolver({ limits: { redirects: 0 } }).resolveCatalog(catalog(f.origin + '/loop')),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    f.routes.set('/loop', (_req, res) => {
      res.writeHead(302);
      res.end();
    });
    await expect(f.resolver().resolveCatalog(catalog(f.origin + '/loop'))).rejects.toMatchObject({
      code: 'SCHEMA_UNAVAILABLE',
    });
    f.routes.set('/loop', (_req, res) => {
      res.writeHead(302, { Location: '/bad%xx' });
      res.end();
    });
    await expect(f.resolver().resolveCatalog(catalog(f.origin + '/loop'))).rejects.toMatchObject({
      code: 'RESOLUTION_POLICY',
    });
    f.routes.set('/loop', (_req, res) => {
      res.writeHead(302, { Location: 'https://[' });
      res.end();
    });
    await expect(f.resolver().resolveCatalog(catalog(f.origin + '/loop'))).rejects.toMatchObject({
      code: 'RESOLUTION_POLICY',
    });
  });
});

describe('integrity, representation encoding and identity-private bounded cache', () => {
  test('integrity failure precedes parsing and never caches poisoned bytes', async () => {
    const f = await fixture();
    f.routes.set('/schema', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/schema+json' });
      res.end('invalid-json-secret');
    });
    const source = catalog(f.origin + '/schema');
    Object.assign(source.contracts[0]!.input.representations[0]!.schema, { integrity: pin('{}') });
    const resolver = f.resolver();
    await expect(resolver.resolveCatalog(source)).rejects.toMatchObject({
      code: 'INTEGRITY_MISMATCH',
    });
    expect(resolver.cache).toEqual({ entries: 0, bytes: 0 });
    const actual = f.json('/schema', {});
    expect(actual).toBe('{}');
    expect(selected(await resolver.resolveCatalog(source)).validate(0)).toBe(0);
  });
  test.each([
    { algorithm: 'sha-256', value: 'a' },
    { algorithm: 'sha-512', value: pin('{}').value },
    { algorithm: 'sha-999', value: pin('{}').value },
    { algorithm: 'sha-256', value: pin('{}').value.slice(0, -1) },
    { algorithm: 'sha-256', value: pin('{}').value.slice(0, -2) + 'B=' },
  ])('rejects noncanonical/invalid integrity %#', async (integrity) => {
    const f = await fixture();
    const source = catalog(f.origin + '/schema');
    Object.assign(source.contracts[0]!.input.representations[0]!.schema, { integrity });
    await expect(f.resolver().resolveCatalog(source)).rejects.toBeInstanceOf(ContractError);
    expect(f.calls).toHaveLength(0);
  });
  test('transitive resources can have independent pins; root integrity does not pin the child', async () => {
    const f = await fixture();
    const root = f.json('/root', { $ref: 'child' });
    const child = f.json('/child', { const: 3 });
    const source = catalog(f.origin + '/root');
    Object.assign(source.contracts[0]!.input.representations[0]!.schema, { integrity: pin(root) });
    const resolver = f.resolver({
      resourceIntegrity: { [f.origin + '/child']: pin(child, 'sha-512') },
    });
    expect(selected(await resolver.resolveCatalog(source)).validate(3)).toBe(3);
    await resolver.resolveCatalog(source);
    expect(f.calls).toHaveLength(2);
    const wrong = f.resolver({ resourceIntegrity: { [f.origin + '/child']: pin('false') } });
    await expect(wrong.resolveCatalog(source)).rejects.toMatchObject({
      code: 'INTEGRITY_MISMATCH',
    });
    await expect(
      f
        .resolver({ resourceIntegrity: { [f.origin + '/root']: pin('false') } })
        .resolveCatalog(source),
    ).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' });
  });
  test('compressed responses, wrong media, invalid UTF-8 and invalid JSON fail without exposure', async () => {
    const f = await fixture();
    for (const [headers, body, code] of [
      [
        { 'Content-Type': 'application/schema+json', 'Content-Encoding': 'gzip' },
        Buffer.from('true'),
        'RESOLUTION_POLICY',
      ],
      [{ 'Content-Type': 'text/html' }, Buffer.from('true'), 'UNSUPPORTED_MEDIA_TYPE'],
      [{}, Buffer.from('true'), 'UNSUPPORTED_MEDIA_TYPE'],
      [{ 'Content-Type': 'application/schema+json' }, Buffer.from([0xff]), 'SCHEMA_INVALID'],
      [{ 'Content-Type': 'application/schema+json' }, Buffer.from('not-json'), 'SCHEMA_INVALID'],
    ] as const) {
      f.routes.set('/schema', (_req, res) => {
        res.writeHead(200, headers);
        res.end(body);
      });
      await expect(
        f.resolver().resolveCatalog(catalog(f.origin + '/schema')),
      ).rejects.toMatchObject({ code });
    }
    f.routes.set('/schema', (_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'Application/Schema+JSON; charset="UTF-8"',
        'Content-Encoding': 'identity',
      });
      res.end('true');
    });
    expect(
      selected(await f.resolver().resolveCatalog(catalog(f.origin + '/schema'))).validate(null),
    ).toBeNull();
  });
  test('same URI with changed pin is re-fetched; mutable schema bytes are never reused', async () => {
    const f = await fixture();
    const first = f.json('/schema', { const: 1 });
    const source = catalog(f.origin + '/schema');
    Object.assign(source.contracts[0]!.input.representations[0]!.schema, { integrity: pin(first) });
    const resolver = f.resolver();
    const old = await resolver.resolveCatalog(source);
    const second = f.json('/schema', { const: 2 });
    Object.assign(source.contracts[0]!.input.representations[0]!.schema, {
      integrity: pin(second),
    });
    expect(selected(await resolver.resolveCatalog(source)).validate(2)).toBe(2);
    expect(selected(old).validate(1)).toBe(1);
    await resolver.resolveCatalog(catalog(f.origin + '/schema'));
    await resolver.resolveCatalog(catalog(f.origin + '/schema'));
    expect(f.calls).toHaveLength(4);
  });
  test('mutable shared documents are consistent within one preparation and fresh across preparations', async () => {
    const f = await fixture();
    let version = 0;
    f.routes.set('/schema', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/schema+json' });
      res.end(JSON.stringify({ const: ++version }));
    });
    const source = catalog(f.origin + '/schema');
    const reps = source.contracts[0]!.input.representations as unknown as Record<string, unknown>[];
    reps.push({ ...reps[0], id: 'other' });
    const resolver = f.resolver({ limits: { documents: 1 } });
    const first = await resolver.resolveCatalog(source);
    expect(selected(first).validate(1)).toBe(1);
    expect(first.select(contractId, 'input', 'other').validate(1)).toBe(1);
    const second = await resolver.resolveCatalog(source);
    expect(second.select(contractId, 'input', 'other').validate(2)).toBe(2);
    expect(f.calls).toHaveLength(2);
    expect(resolver.cache.entries).toBe(0);
  });
  test('cache LRU/count/bytes/clear and disabled cache are enforced', async () => {
    const f = await fixture();
    const a = f.json('/a', true);
    const b = f.json('/b', false);
    const resolver = f.resolver({
      immutableResources: [f.origin + '/a', f.origin + '/b'],
      limits: { cacheEntries: 1, cacheBytes: 5 },
    });
    await resolver.resolveCatalog(catalog(f.origin + '/a'));
    expect(resolver.cache.bytes).toBe(Buffer.byteLength(a));
    await resolver.resolveCatalog(catalog(f.origin + '/b'));
    expect(resolver.cache).toEqual({ entries: 1, bytes: Buffer.byteLength(b) });
    await resolver.resolveCatalog(catalog(f.origin + '/a'));
    expect(f.calls).toHaveLength(3);
    resolver.clearCache();
    expect(resolver.cache).toEqual({ entries: 0, bytes: 0 });
    for (const limits of [{ cacheEntries: 0 }, { cacheBytes: 0 }]) {
      const disabled = f.resolver({ immutableResources: [f.origin + '/a'], limits });
      await disabled.resolveCatalog(catalog(f.origin + '/a'));
      expect(disabled.cache.entries).toBe(0);
    }
  });
  test('cache/credentials/configuration snapshots do not cross identities or leak into errors', async () => {
    const f = await fixture();
    f.routes.set('/schema', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/schema+json' });
      res.end(JSON.stringify({ const: req.headers.authorization }));
    });
    const authorization = { [f.origin]: 'tenant-secret-a' };
    const options = {
      authorization,
      immutableResources: [f.origin + '/schema'],
      allowedOrigins: [f.origin],
    };
    const a = f.resolver(options);
    authorization[f.origin] = 'mutated';
    options.allowedOrigins.length = 0;
    const b = f.resolver({
      authorization: { [f.origin]: 'tenant-secret-b' },
      immutableResources: [f.origin + '/schema'],
    });
    expect(
      selected(await a.resolveCatalog(catalog(f.origin + '/schema'))).validate('tenant-secret-a'),
    ).toBe('tenant-secret-a');
    expect(
      selected(await b.resolveCatalog(catalog(f.origin + '/schema'))).validate('tenant-secret-b'),
    ).toBe('tenant-secret-b');
    await a.resolveCatalog(catalog(f.origin + '/schema'));
    expect(f.calls).toHaveLength(2);
    await expect(a.resolveCatalog(catalog(f.origin + '/missing-secret'))).rejects.toThrow(
      'Schema Contract rejected: SCHEMA_UNAVAILABLE.',
    );
  });
});

describe('graph/resource budgets, cycle detection and cancellation', () => {
  test('retrieval cycles including aliases are rejected, while DAG reuse is allowed', async () => {
    const f = await fixture();
    f.json('/a', { $id: f.origin + '/logical-a', $ref: 'b' });
    f.json('/b', { $ref: 'logical-a' });
    await expect(f.resolver().resolveCatalog(catalog(f.origin + '/a'))).rejects.toMatchObject({
      code: 'REFERENCE_CYCLE',
    });
    f.json('/a', { allOf: [{ $ref: 'b' }, { $ref: 'c' }] });
    f.json('/b', { $ref: 'shared' });
    f.json('/c', { $ref: 'shared' });
    f.json('/shared', { type: 'integer' });
    const prepared = await f.resolver().resolveCatalog(catalog(f.origin + '/a'));
    expect(selected(prepared).validate(1)).toBe(1);
    expect(f.calls.filter((c) => c.path === '/shared')).toHaveLength(1);
  });
  test('duplicate resource IDs and fragment-bearing IDs fail closed', async () => {
    const f = await fixture();
    for (const schema of [
      { $defs: { a: { $id: 'same', type: 'integer' }, b: { $id: 'same', type: 'string' } } },
      { $id: f.origin + '/schema#anchor', type: 'integer' },
      { $id: 'bad%xx', type: 'integer' },
      { $id: f.origin + '/schema', $ref: 'bad%xx' },
      { $id: f.origin + '/schema', $ref: 'https://user:secret@catalog.test/schema' },
    ]) {
      f.json('/schema', schema);
      await expect(
        f.resolver().resolveCatalog(catalog(f.origin + '/schema')),
      ).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
    }
  });
  test.each(['documents', 'referenceDepth', 'references', 'schemas', 'totalBytes'] as const)(
    'enforces %s before exposure',
    async (limit) => {
      const f = await fixture();
      f.json('/a', { allOf: [{ $ref: 'b' }, { $ref: 'c' }] });
      f.json('/b', { $ref: 'c' });
      f.json('/c', true);
      await expect(
        f.resolver({ limits: { [limit]: 1 } }).resolveCatalog(catalog(f.origin + '/a')),
      ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    },
  );
  test('response byte bounds apply to Content-Length and chunked bodies', async () => {
    const f = await fixture();
    f.json('/schema', { description: 'x'.repeat(100) });
    await expect(
      f.resolver({ limits: { responseBytes: 16 } }).resolveCatalog(catalog(f.origin + '/schema')),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    f.routes.set('/schema', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/schema+json' });
      res.write(' '.repeat(17));
      res.end('true');
    });
    await expect(
      f.resolver({ limits: { responseBytes: 16 } }).resolveCatalog(catalog(f.origin + '/schema')),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
  });
  test('declared Content-Length and interrupted response bodies fail before parsing', async () => {
    const f = await fixture();
    f.routes.set('/schema', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/schema+json', 'Content-Length': 100 });
      res.end('true');
    });
    await expect(
      f.resolver({ limits: { responseBytes: 16 } }).resolveCatalog(catalog(f.origin + '/schema')),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    f.routes.set('/schema', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/schema+json' });
      res.write(' ');
      res.destroy();
    });
    await expect(f.resolver().resolveCatalog(catalog(f.origin + '/schema'))).rejects.toMatchObject({
      code: 'SCHEMA_UNAVAILABLE',
    });
  });
  test('JSON nesting and graph node work are bounded before compilation', async () => {
    const f = await fixture();
    let schema: unknown = true;
    for (let i = 0; i < 40; i++) schema = { items: schema };
    f.json('/schema', schema);
    await expect(f.resolver().resolveCatalog(catalog(f.origin + '/schema'))).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT',
    });
  });
  test('hanging DNS and HTTP bodies have deadlines and abort releases operation capacity', async () => {
    const f = await fixture();
    const dns = f.resolver({ lookup: () => new Promise(() => {}), limits: { deadlineMs: 15 } });
    await expect(dns.resolveCatalog(catalog(f.origin + '/schema'))).rejects.toMatchObject({
      code: 'RESOLUTION_TIMEOUT',
    });
    f.routes.set('/hang', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/schema+json' });
      res.write(' ');
    });
    await expect(
      f.resolver({ limits: { deadlineMs: 25 } }).resolveCatalog(catalog(f.origin + '/hang')),
    ).rejects.toMatchObject({ code: 'RESOLUTION_TIMEOUT' });
    const controller = new AbortController();
    const resolver = f.resolver({ limits: { concurrent: 1 } });
    const pending = resolver.resolveCatalog(catalog(f.origin + '/hang'), {
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'RESOLUTION_ABORTED' });
    await expect(resolver.resolveCatalog(catalog())).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT',
    });
    controller.abort('secret-abort-reason');
    await rejected;
    expect(selected(await resolver.resolveCatalog(catalog())).validate(0)).toBe(0);
    expect(resolver.cache.entries).toBe(0);
  });
  test('pre-aborted calls do no DNS and invalid extension metadata fails locally', async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.resolver().resolveCatalog(catalog(f.origin + '/schema'), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'RESOLUTION_ABORTED' });
    expect(f.dns).not.toHaveBeenCalled();
    for (const value of [
      null,
      { uri: 'wrong', params: {} },
      { uri: EXTENSION_URI, required: 'yes', params: {} },
      { uri: EXTENSION_URI, params: {} },
    ]) {
      await expect(f.resolver().resolveExtension(value)).rejects.toBeInstanceOf(ContractError);
    }
    await expect(
      f.resolver().resolveExtensionParams(external(f.origin + '/catalog#fragment', pin('{}'))),
    ).rejects.toMatchObject({ code: 'RESOLUTION_POLICY' });
  });
  test.each(Object.entries(RESOLVER_LIMITS))(
    'configuration cannot raise %s hard maximum',
    (name, max) => {
      expect(() => createContractResolver({ limits: { [name]: max + 1 } })).toThrow(TypeError);
      expect(() => createContractResolver({ limits: { [name]: -1 } })).toThrow(TypeError);
      expect(() => createContractResolver({ limits: { [name]: 0.5 } })).toThrow(TypeError);
    },
  );
  test.each([
    'RESOLUTION_POLICY',
    'INTEGRITY_MISMATCH',
    'RESOLUTION_ABORTED',
    'RESOLUTION_TIMEOUT',
    'REFERENCE_CYCLE',
  ] as const)('diagnostic %s maps only to existing draft SCHEMA_UNAVAILABLE', (code) => {
    const error = new ContractError(code, {
      origin: 'remote',
      contractId,
      direction: 'input',
      representationId: 'json',
    });
    expect(error.detail?.code).toBe('SCHEMA_UNAVAILABLE');
    expect(JSON.stringify(error)).not.toContain('secret');
  });
  test('HTTP scheme never reaches a live cleartext server', async () => {
    let calls = 0;
    const server = createServer((_req, res) => {
      calls++;
      res.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    cleanup.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture address.');
    await expect(
      createContractResolver().resolveCatalog(catalog(`http://127.0.0.1:${address.port}/schema`)),
    ).rejects.toMatchObject({ code: 'RESOLUTION_POLICY' });
    expect(calls).toBe(0);
  });
});
