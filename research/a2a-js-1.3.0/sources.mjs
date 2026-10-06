import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const sources = [
  ['released-extension-sample', '29417a5bb4038f804f310ce4fffd267a9375aa90', 'https://raw.githubusercontent.com/a2aproject/a2a-js/29417a5bb4038f804f310ce4fffd267a9375aa90/src/samples/extensions/README.md'],
  ['a2ui', '46ecc2d04793c0b8b1c77f8acd9d7ab4e34746c2', 'https://raw.githubusercontent.com/a2ui-project/a2ui/46ecc2d04793c0b8b1c77f8acd9d7ab4e34746c2/README.md'],
  ['traceability', '6603ba3f2c31a7ef33e70b9d8b5b5f8be42ac9a3', 'https://raw.githubusercontent.com/a2aproject/a2a-samples/6603ba3f2c31a7ef33e70b9d8b5b5f8be42ac9a3/extensions/traceability/v1/spec.md'],
  ['a202', '8473b0421fdc2a0d9e4bcd299cf9937ee68bf556', 'https://raw.githubusercontent.com/a202-protocol/a202/8473b0421fdc2a0d9e4bcd299cf9937ee68bf556/reference/README.md'],
];
const results = [];
for (const [name, revision, url] of sources) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  results.push({ name, revision, url, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
  console.log(`${name}: fetched pinned source (${bytes.length} bytes)`);
}
await writeFile(new URL('sources.json', import.meta.url), JSON.stringify({ checkedOn: '2026-10-06', sources: results }, null, 2) + '\n');
