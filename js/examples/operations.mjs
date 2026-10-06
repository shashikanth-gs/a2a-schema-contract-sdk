import assert from 'node:assert/strict';
import { parseCatalog, JSON_SCHEMA_DIALECT } from 'a2a-schema-contract/core';
import { createValidationSession } from 'a2a-schema-contract/operations';

const id = 'urn:example:isolated:1';
const branch = {
  type: 'object',
  required: ['child'],
  properties: { child: { allOf: [{ $ref: '#/$defs/branch' }, { $ref: '#/$defs/branch' }] } },
};
const source = parseCatalog({
  contracts: [
    {
      id,
      input: {
        presence: 'required',
        representations: [
          {
            id: 'json',
            mediaType: 'application/json',
            schema: {
              mediaType: 'application/schema+json',
              dialect: JSON_SCHEMA_DIALECT,
              inline: {
                $defs: { branch: { anyOf: [{ type: 'null' }, branch] } },
                $ref: '#/$defs/branch',
              },
            },
          },
        ],
      },
      output: { presence: 'none' },
    },
  ],
});
const diagnostics = [];
const session = createValidationSession(source, {
  deadlineMs: 1000,
  diagnostics: (event) => diagnostics.push(event),
});
const selection = { contractId: id, direction: 'input', representationId: 'json' };
let value = null;
for (let i = 0; i < 25; i++) value = { child: value };
try {
  await assert.rejects(session.run('validate', { ...selection, value }), {
    code: 'VALIDATION_TIMEOUT',
  });
  assert.equal(session.active, 0);
  assert.equal(await session.run('validate', { ...selection, value: null }), null);
  const controller = new AbortController();
  const pending = session.run('validate', { ...selection, value }, { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'VALIDATION_ABORTED' });
  controller.abort(new Error('secret-abort'));
  await rejected;
  assert.equal(session.active, 0);
  assert.ok(diagnostics.some((event) => event.code === 'VALIDATION_TIMEOUT'));
  assert.ok(!JSON.stringify(diagnostics).includes('secret'));
} finally {
  await session.close();
}
console.log(
  JSON.stringify({
    result: 'PASS',
    checks: [
      'hostile-schema-deadline',
      'valid-core-worker-without-peer',
      'abort-termination',
      'zero-active-workers',
      'diagnostic-redaction',
    ],
  }),
);
