import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
assert.equal(metadata.private, true, 'Publication remains disabled for this rehearsal.');
assert.match(metadata.version, /^\d+\.\d+\.\d+-rc\.\d+$/u);
assert.equal(metadata.name, 'a2a-schema-contract');
assert.ok(process.env.npm_execpath);
const run = (args) =>
  JSON.parse(
    execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120000,
    }),
  );
const output = path.join(root, 'artifacts');
await mkdir(output, { recursive: true });
const preview = run(['pack', '--dry-run', '--ignore-scripts', '--json'])[0];
const first = run(['pack', '--ignore-scripts', '--json', '--pack-destination', output])[0];
const before = createHash('sha256')
  .update(await readFile(path.join(output, first.filename)))
  .digest('hex');
const second = run(['pack', '--ignore-scripts', '--json', '--pack-destination', output])[0];
const after = createHash('sha256')
  .update(await readFile(path.join(output, second.filename)))
  .digest('hex');
assert.equal(before, after);
assert.deepEqual(preview.files, first.files);
const report = {
  result: 'PASS',
  runtime: process.version,
  packageName: metadata.name,
  version: metadata.version,
  artifact: first.filename,
  sha256: after,
  packageIntegrity: first.integrity,
  immutableTagPolicy: `js-v${metadata.version}`,
  publication: 'Disabled by private=true. No publish, release, tag or registry mutation occurs.',
  provenance:
    'Local checksums and pinned input attribution; registry OIDC/provenance requires an authenticated initial package publication and a separately authorized workflow.',
  reproduciblePacks: 2,
  files: first.files.length,
};
await mkdir(path.join(root, 'reports'), { recursive: true });
await writeFile(
  path.join(root, 'reports', `release-node${process.versions.node.split('.')[0]}.json`),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report));
