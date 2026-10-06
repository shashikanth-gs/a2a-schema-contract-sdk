import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { expect, test } from 'vitest';

test('built public client/server APIs enforce prepared external schemas over HTTP/SSE', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['examples/external.mjs'], {
    timeout: 30000,
  });
  const report = JSON.parse(stdout) as {
    result: string;
    checks: string[];
    retrievals: number;
    executions: number;
  };
  expect(report.result).toBe('PASS');
  expect(report.checks).toHaveLength(10);
  expect(report.retrievals).toBe(6);
  expect(report.executions).toBe(4);
}, 35000);
