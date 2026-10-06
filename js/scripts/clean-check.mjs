import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scratch = await mkdtemp(path.join(os.tmpdir(), 'schema-contract-clean-'));
let output = '';
try {
  await cp(path.join(root, 'js'), path.join(scratch, 'js'), {
    recursive: true,
    filter: (source) =>
      !['node_modules', 'dist', 'artifacts', 'reports', 'coverage'].includes(path.basename(source)),
  });
  for (const name of ['vendor', 'tests', 'LICENSE', 'contract-source.json'])
    await cp(path.join(root, name), path.join(scratch, name), { recursive: true });
  assert.ok(
    process.env.npm_execpath,
    'Run via npm run check:clean so npm CLI ownership is explicit.',
  );
  for (const args of [['ci'], ['run', 'check']]) {
    output += execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
      cwd: path.join(scratch, 'js'),
      encoding: 'utf8',
      timeout: 180000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  const major = process.versions.node.split('.')[0];
  const reportDir = path.join(root, 'js/reports');
  await mkdir(reportDir, { recursive: true });
  await cp(
    path.join(scratch, `js/reports/resolver-package-node${major}.json`),
    path.join(reportDir, `resolver-package-node${major}.json`),
  );
  const packageReport = JSON.parse(
    await readFile(path.join(reportDir, `resolver-package-node${major}.json`), 'utf8'),
  );
  const artifactDir = path.join(root, `js/artifacts/resolver-node${major}`);
  await mkdir(artifactDir, { recursive: true });
  await cp(
    path.join(scratch, 'js/artifacts', packageReport.artifact),
    path.join(artifactDir, packageReport.artifact),
  );
  const coverage = JSON.parse(
    await readFile(path.join(scratch, 'js/coverage/coverage-summary.json'), 'utf8'),
  ).total;
  await writeFile(
    path.join(reportDir, `resolver-clean-node${major}.json`),
    JSON.stringify(
      {
        task: 'SDK-006',
        runtime: process.version,
        platform: `${process.platform}/${process.arch}`,
        commands: ['npm ci', 'npm run check'],
        result: 'PASS',
        environment:
          'Temporary independent source copy with no inputs/, node_modules/, dist/ or previous reports.',
        coverage,
        hostedCi: 'Not run; workflows configured locally.',
      },
      null,
      2,
    ) + '\n',
  );
  await writeFile(path.join(reportDir, `resolver-clean-node${major}.log`), output);
  console.log(
    `PASS fresh npm ci + complete package checks on ${process.version}; reports/resolver-clean-node${major}.json`,
  );
} catch (error) {
  if (error.stdout) output += error.stdout.toString();
  if (error.stderr) output += error.stderr.toString();
  console.error(output);
  throw error;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
