import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'artifacts');
const reports = path.join(root, 'reports');
const temp = await mkdtemp(path.join(os.tmpdir(), 'schema-contract-consumer-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function command(program, args, cwd = temp) {
  // On Windows use the npm CLI JS file instead of shelling out to a .cmd wrapper.
  if (program === npm && process.env.npm_execpath) {
    return execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  return execFileSync(program, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
try {
  await mkdir(output, { recursive: true });
  await mkdir(reports, { recursive: true });
  const pack = JSON.parse(
    command(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', output], root),
  )[0];
  const tarball = path.join(output, pack.filename);
  const names = pack.files.map((file) => file.path);
  for (const name of [
    'LICENSE',
    'NOTICE',
    'README.md',
    'dist/index.js',
    'dist/index.d.ts',
    'dist/resolver/index.js',
    'dist/resolver/index.d.ts',
    'dist/operations/worker.js',
    'dist/operations/index.d.ts',
    'dist/resources/manifest.json',
    'dist/resources/LICENSE',
    'dist/resources/NOTICE',
  ])
    assert.ok(names.includes(name), name);
  assert.equal(names.filter((name) => /^dist\/resources\/schema\/.*\.json$/u.test(name)).length, 7);
  assert.ok(
    !names.some((name) => /(^src\/|^test\/|node_modules|\.env|vendor\/|research\/)/u.test(name)),
  );
  await writeFile(
    path.join(temp, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }) + '\n',
  );
  command(npm, ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', tarball]);
  const installed = path.join(temp, 'node_modules/a2a-schema-contract');
  const modules = await readdir(path.join(temp, 'node_modules'));
  assert.ok(!modules.includes('express'));
  assert.ok(!modules.includes('@a2a-js'));
  assert.ok(!modules.includes('typescript'));
  const js = `
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as root from 'a2a-schema-contract';
import * as core from 'a2a-schema-contract/core';
import { createContractResolver } from 'a2a-schema-contract/resolver';
const prepared = await createContractResolver().resolveCatalog({ contracts: [{ id: 'urn:example:external:1', input: { presence: 'none' }, output: { presence: 'none' } }] });
assert.equal(prepared.getContract('urn:example:external:1').input.presence, 'none');
await assert.rejects(import('a2a-schema-contract/dist/resolver/prepared.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
for (const api of [root, core]) assert.equal(api.EXTENSION_URI, 'https://w3id.org/a2a-schema-contract/draft/0.1');
assert.equal(core.SCHEMA_NAMES.length, 7);
for (const name of core.SCHEMA_NAMES) {
  const schema = JSON.parse(await readFile(core.getSchemaResource(name), 'utf8'));
  assert.equal(schema.$schema, core.JSON_SCHEMA_DIALECT);
}
assert.throws(() => core.getSchemaResource('../../package.json'), TypeError);
await assert.rejects(import('a2a-schema-contract/dist/core/index.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
await assert.rejects(import('a2a-schema-contract/src/core/index.ts'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
`;
  await writeFile(path.join(temp, 'consumer.mjs'), js);
  command(process.execPath, ['consumer.mjs']);
  await cp(path.join(root, 'examples/operations.mjs'), path.join(temp, 'operations.mjs'));
  const operationsReport = JSON.parse(command(process.execPath, ['operations.mjs']).trim());
  assert.equal(operationsReport.result, 'PASS');
  // Execute the documented snippet outside the checkout using only public imports.
  await cp(path.join(root, 'examples/resource.mjs'), path.join(temp, 'resource.mjs'));
  command(process.execPath, ['resource.mjs']);
  await cp(path.join(root, 'examples/core.mjs'), path.join(temp, 'core.mjs'));
  command(process.execPath, ['core.mjs']);
  await cp(path.join(root, 'examples/discovery.mjs'), path.join(temp, 'discovery.mjs'));
  command(process.execPath, ['discovery.mjs']);
  // Strict core declarations must work before the optional official SDK is installed.
  command(npm, [
    'install',
    '--save-dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    'typescript@5.9.3',
    '@types/node@22.20.5',
    'ajv-formats@3.0.1',
  ]);
  const tsconfig = {
    compilerOptions: {
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      target: 'ES2022',
      skipLibCheck: false,
      noEmit: true,
    },
    include: ['consumer.ts'],
  };
  await writeFile(path.join(temp, 'tsconfig.json'), JSON.stringify(tsconfig));
  const types = `
import { parseCatalog, encodePrimary, type Payload, getSchemaResource, type JsonValue, type Presence } from 'a2a-schema-contract';
import { EXTENSION_URI, type Direction } from 'a2a-schema-contract/core';
const value: JsonValue = { nullValue: null, list: [false, 'text', 0] };
const presence: Presence = 'none';
const direction: Direction = 'input';
const resource: URL = getSchemaResource('catalog');
// @ts-expect-error Invalid resource names cannot enter the public typed API.
getSchemaResource('unregistered');
// @ts-expect-error Runtime discovery does not imply a domain type.
const unchecked: JsonValue = {} as unknown;
const discovered = parseCatalog({ contracts: [{ id: 'urn:example:contract:1', input: { presence: 'required', representations: [{ id: 'json', mediaType: 'application/json' }] }, output: { presence: 'none' } }] });
const dynamic: JsonValue = discovered.select('urn:example:contract:1', 'input', 'json').validate({ count: 0 });
// @ts-expect-error Runtime validation cannot invent a statically known domain type.
const domain: { count: number } = dynamic;
const encoded: JsonValue = encodePrimary(discovered.select('urn:example:contract:1', 'input', 'json'), dynamic);
const absence: Payload = { present: false };
void [value, presence, direction, resource, EXTENSION_URI, unchecked, domain, encoded, absence];
`;
  await writeFile(path.join(temp, 'consumer.ts'), types);
  const tsc = path.join(temp, 'node_modules/typescript/bin/tsc');
  command(process.execPath, [tsc, '-p', 'tsconfig.json']);
  await cp(path.join(root, 'examples/resolver-types.ts'), path.join(temp, 'resolver-types.ts'));
  await writeFile(
    path.join(temp, 'tsconfig.resolver.json'),
    JSON.stringify({ ...tsconfig, include: ['resolver-types.ts'] }),
  );
  command(process.execPath, [tsc, '-p', 'tsconfig.resolver.json']);
  await cp(path.join(root, 'examples/operations-types.ts'), path.join(temp, 'operations-types.ts'));
  await writeFile(
    path.join(temp, 'tsconfig.operations.json'),
    JSON.stringify({ ...tsconfig, include: ['operations-types.ts'] }),
  );
  command(process.execPath, [tsc, '-p', 'tsconfig.operations.json']);
  await cp(path.join(root, '../vendor/contract'), path.join(temp, 'conformance-fixture'), {
    recursive: true,
  });
  await cp(path.join(root, 'examples/conformance.mjs'), path.join(temp, 'conformance.mjs'));
  const conformanceReport = JSON.parse(
    command(process.execPath, ['conformance.mjs', path.join(temp, 'conformance-fixture')]).trim(),
  );
  assert.equal(conformanceReport.installedStructuralCases, 20);

  command(npm, [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '@a2a-js/sdk@1.3.0',
    'express@5.1.0',
  ]);
  await writeFile(
    path.join(temp, 'adapters.mjs'),
    `import assert from 'node:assert/strict';
import { createContractClient } from 'a2a-schema-contract/client';
import { createContractServer } from 'a2a-schema-contract/server';
import { A2A_JS_SDK_VERSION } from 'a2a-schema-contract/adapters/a2a-js';
assert.equal(typeof createContractClient, 'function'); assert.equal(typeof createContractServer, 'function'); assert.equal(A2A_JS_SDK_VERSION, '1.3.0');
`,
  );
  command(process.execPath, ['adapters.mjs']);
  await cp(path.join(root, 'examples/http.mjs'), path.join(temp, 'http.mjs'));
  const transportReport = JSON.parse(command(process.execPath, ['http.mjs']).trim());
  assert.equal(transportReport.result, 'PASS');
  await cp(path.join(root, 'examples/external.mjs'), path.join(temp, 'external.mjs'));
  await cp(path.join(root, 'test/fixtures/tls'), path.join(temp, 'tls-fixture'), {
    recursive: true,
  });
  const externalReport = JSON.parse(
    command(process.execPath, ['external.mjs', path.join(temp, 'tls-fixture')]).trim(),
  );
  assert.equal(externalReport.result, 'PASS');
  assert.equal(externalReport.checks.length, 10);
  await cp(path.join(root, 'examples/benchmarks.mjs'), path.join(temp, 'benchmarks.mjs'));
  const benchmarkReport = JSON.parse(
    command(process.execPath, ['benchmarks.mjs', path.join(temp, 'tls-fixture')]).trim(),
  );
  assert.equal(benchmarkReport.result, 'PASS');

  await cp(path.join(root, 'examples/http-types.ts'), path.join(temp, 'http-types.ts'));
  await writeFile(
    path.join(temp, 'tsconfig.http.json'),
    JSON.stringify({ ...tsconfig, include: ['http-types.ts'] }),
  );
  command(process.execPath, [tsc, '-p', 'tsconfig.http.json']);
  await writeFile(
    path.join(temp, 'consumer.ts'),
    types +
      `
import { A2A_JS_SDK_VERSION, type Client, type AgentExecutor } from 'a2a-schema-contract/adapters/a2a-js';
type Integration = { client: Client; executor: AgentExecutor };
const peerVersion: '1.3.0' = A2A_JS_SDK_VERSION;
const integration: Integration | undefined = undefined;
void [peerVersion, integration];
`,
  );
  command(process.execPath, [tsc, '-p', 'tsconfig.json']);
  const peer = JSON.parse(
    await readFile(path.join(temp, 'node_modules/@a2a-js/sdk/package.json'), 'utf8'),
  );
  assert.equal(peer.version, '1.3.0');
  const installedManifest = JSON.parse(
    await readFile(path.join(installed, 'dist/resources/manifest.json'), 'utf8'),
  );
  for (const [name, hash] of Object.entries(installedManifest.files).filter(([name]) =>
    name.startsWith('schema/'),
  )) {
    assert.equal(
      createHash('sha256')
        .update(await readFile(path.join(installed, 'dist/resources', name)))
        .digest('hex'),
      hash,
    );
  }
  const runtimeAudit = JSON.parse(command(npm, ['audit', '--omit=dev', '--json']));
  assert.equal(runtimeAudit.metadata.vulnerabilities.total, 0);
  const report = {
    task: 'SDK-007/008',
    runtime: process.version,
    platform: `${process.platform}/${process.arch}`,
    artifact: pack.filename,
    version: pack.version,
    artifactSha256: createHash('sha256')
      .update(await readFile(tarball))
      .digest('hex'),
    integrity: pack.integrity,
    sourceCommit: installedManifest.commit,
    files: names,
    checks: [
      'plain-JS-core-imports-without-peer',
      'all-adapter-imports-with-peer',
      'installed-real-HTTP-and-SSE-quickstart',
      'strict-installed-client-server-quickstart-types',
      'seven-installed-resources-with-original-hashes',
      'license-and-notice',
      'no-source-or-dev-files',
      'core-install-without-optional-peer',
      'documented-resource-example',
      'installed-offline-core-example-and-rejection',
      'installed-ajv-reserved-schema-map-refusal',
      'documented-discovery-snippet',
      'dynamic-schema-types-do-not-invent-domain-types',
      'strict-core-types-without-peer',
      'strict-adapter-types-with-exact-peer',
      'private-paths-rejected',
      'runtime-audit-zero',
      'resolver-import-and-preparation-without-peer',
      'strict-resolver-types-without-peer',
      'installed-HTTPS-external-catalog-schema-and-HTTP-SSE-quickstart',
      'private-resolver-branding-seam-rejected',
      'installed-isolated-core-without-optional-peer',
      'installed-hostile-schema-timeout-abort-and-worker-cleanup',
      'strict-installed-operational-types',
      '20-pinned-structural-cases-against-shipped-schemas',
      'repeatable-installed-cold-warm-core-worker-and-HTTPS-benchmarks',
    ],
    operationsReport,
    conformanceReport,
    benchmarkReport,
    transportReport,
    externalReport,
    peerBounds: {
      minimum: peer.version,
      maximum: peer.version,
      policy: 'Exact peer range; one artifact tests both bounds.',
    },
    consumerLockSha256: createHash('sha256')
      .update(await readFile(path.join(temp, 'package-lock.json')))
      .digest('hex'),
    limits: [
      'Bounded Node JSON/text and HTTPS profile; Python, bundles/XML and other transports remain excluded.',
      'This report records its own runtime; hosted runs retain independent reports.',
    ],
  };
  await writeFile(
    path.join(reports, `rc-package-node${process.versions.node.split('.')[0]}.json`),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    `PASS isolated installed consumer, declarations, exact peer bounds and audit: ${pack.filename}`,
  );
  console.log(`SHA-256 ${report.artifactSha256}`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
