import assert from 'node:assert/strict';
import { format } from 'prettier';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const snapshot = new URL('../../vendor/contract/', import.meta.url);
const dist = new URL('../dist/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', snapshot), 'utf8'));
const pin = JSON.parse(
  await readFile(new URL('../../contract-source.json', import.meta.url), 'utf8'),
);
assert.equal(manifest.commit, pin.commit, 'Snapshot revision must match the contract pin.');
assert.equal(
  manifest.extensionUri,
  pin.extensionUri,
  'Snapshot namespace must match the contract pin.',
);
// Verify every file before touching existing build output.
for (const [name, hash] of Object.entries(manifest.files)) {
  assert.equal(
    createHash('sha256')
      .update(await readFile(new URL(name, snapshot)))
      .digest('hex'),
    hash,
    name,
  );
}
await rm(dist, { recursive: true, force: true });
await mkdir(new URL('resources/schema/', dist), { recursive: true });
for (const name of Object.keys(manifest.files).filter((name) => name.startsWith('schema/'))) {
  await copyFile(new URL(name, snapshot), new URL(`resources/${name}`, dist));
}
for (const name of ['manifest.json', 'LICENSE', 'NOTICE'])
  await copyFile(new URL(name, snapshot), new URL(`resources/${name}`, dist));
await copyFile(new URL('../../LICENSE', import.meta.url), new URL('../LICENSE', import.meta.url));
await copyFile(new URL('NOTICE', snapshot), new URL('../NOTICE', import.meta.url));
console.log(
  `Verified ${Object.keys(manifest.files).length} source hashes; packaged seven schemas and attribution.`,
);

// Embed verified structures so core parsing needs no filesystem or network reads.
const structures = [];
for (const name of Object.keys(manifest.files).filter((name) => name.startsWith('schema/'))) {
  structures.push(JSON.parse(await readFile(new URL(name, snapshot), 'utf8')));
}
await writeFile(
  new URL('../src/core/structures-data.ts', import.meta.url),
  await format(
    '/* Generated from the verified contract snapshot; do not edit. */\nexport const structures: readonly object[] = ' +
      JSON.stringify(structures) +
      ';\n',
    { parser: 'typescript', singleQuote: true, printWidth: 92 },
  ),
);
