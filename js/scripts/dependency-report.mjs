import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const reviewed = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'BlueOak-1.0.0',
  'MPL-2.0',
]);
const dependencies = [];
for (const [location, entry] of Object.entries(lock.packages)) {
  if (!location) continue;
  let metadata;
  try {
    metadata = JSON.parse(await readFile(path.join(root, location, 'package.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    continue;
  }
  assert.ok(
    typeof metadata.license === 'string' && reviewed.has(metadata.license),
    `Review new license metadata for ${metadata.name}`,
  );
  // MPL native tooling is reviewed as development-only; no dependency is bundled in the SDK.
  if (metadata.license === 'MPL-2.0') assert.equal(entry.dev, true);
  dependencies.push({
    name: metadata.name,
    version: metadata.version,
    license: metadata.license,
    developmentOnly: entry.dev === true,
    optional: entry.optional === true,
  });
}
assert.ok(process.env.npm_execpath);
const audit = JSON.parse(
  execFileSync(process.execPath, [process.env.npm_execpath, 'audit', '--json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
  }),
);
assert.equal(audit.metadata.vulnerabilities.total, 0);
const report = {
  result: 'PASS',
  runtime: process.version,
  platform: `${process.platform}/${process.arch}`,
  audit: audit.metadata.vulnerabilities,
  dependencies,
  licenseReview:
    'Package metadata for installed dependencies; optional foreign-platform variants are checked on their own hosted runners. MPL-2.0 native test tooling is development-only and is not bundled. This report is technical inventory, not legal certification.',
};
await mkdir(path.join(root, 'reports'), { recursive: true });
await writeFile(
  path.join(root, 'reports', `rc-dependencies-node${process.versions.node.split('.')[0]}.json`),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(
  `PASS dependency audit and reviewed license metadata: ${dependencies.length} installed packages`,
);
