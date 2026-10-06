import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const pin = JSON.parse(await readFile(path.join(root, 'contract-source.json'), 'utf8'));
const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/snapshot-contract.mjs /path/to/specification-checkout');
const head = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (head !== pin.commit) throw new Error('Specification revision does not match contract-source.json.');
const files = execFileSync('git', ['-C', source, 'ls-tree', '-r', '--name-only', pin.commit], { encoding: 'utf8' }).trim().split('\n')
  .filter(name => /^(schema\/|conformance\/|examples\/|scripts\/validate\.mjs$|LICENSE$|NOTICE$)/u.test(name));
const hashes = {};
for (const name of files) {
  const bytes = execFileSync('git', ['-C', source, 'show', `${pin.commit}:${name}`]);
  const target = path.join(root, 'vendor/contract', name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  hashes[name] = createHash('sha256').update(bytes).digest('hex');
}
await writeFile(path.join(root, 'vendor/contract/manifest.json'), JSON.stringify({ ...pin, files: hashes }, null, 2) + '\n');
console.log(`Snapshotted ${files.length} files from ${pin.commit}; working-tree edits are not copied.`);
