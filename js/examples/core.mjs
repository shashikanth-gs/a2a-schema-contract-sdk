import assert from 'node:assert/strict';

import {
  ContractError,
  encodePrimary,
  EXTENSION_URI,
  JSON_SCHEMA_DIALECT,
  parseExtension,
  validateInvocation,
  validateResult,
} from 'a2a-schema-contract/core';

// This example knows no business type at compile time. Discovery is validated data.
const contractId = 'https://contracts.example.org/unknown-domain/1.0';
const extension = {
  uri: EXTENSION_URI,
  required: false,
  params: {
    catalog: {
      inline: {
        contracts: [
          {
            id: contractId,
            input: {
              presence: 'required',
              representations: [{ id: 'prompt', mediaType: 'text/plain' }],
            },
            output: {
              presence: 'required',
              representations: [
                {
                  id: 'answer',
                  mediaType: 'application/json',
                  schema: {
                    mediaType: 'application/schema+json',
                    dialect: JSON_SCHEMA_DIALECT,
                    inline: {
                      type: 'object',
                      required: ['count'],
                      properties: { count: { type: 'integer', minimum: 0 } },
                      additionalProperties: false,
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    },
  },
};
const catalog = parseExtension(extension);
assert.equal(catalog.capabilities(contractId, 'output')[0].supported, true);
const input = encodePrimary(catalog.select(contractId, 'input', 'prompt'), '', 'a2a-js-1.3.0');
const invocation = validateInvocation(
  catalog,
  {
    [EXTENSION_URI]: {
      contractId,
      inputRepresentationId: 'prompt',
      acceptedOutputRepresentationIds: ['answer'],
    },
  },
  [input],
  'a2a-js-1.3.0',
);
assert.deepEqual(invocation.input.value, '');
const output = encodePrimary(
  catalog.select(contractId, 'output', 'answer'),
  { count: 0 },
  'a2a-js-1.3.0',
);
const result = validateResult(
  catalog,
  contractId,
  {
    [EXTENSION_URI]: {
      contractId,
      outputRepresentationId: 'answer',
    },
  },
  [output],
  'answer',
  'a2a-js-1.3.0',
);
assert.deepEqual(result.value, { count: 0 });
assert.throws(
  () => encodePrimary(catalog.select(contractId, 'output', 'answer'), { count: '0' }),
  (error) =>
    error instanceof ContractError && error.code === 'INSTANCE_INVALID' && error.origin === 'local',
);
const unsupported = globalThis.structuredClone(extension);
unsupported.params.catalog.inline.contracts[0].output.representations[0].schema.inline = JSON.parse(
  '{"type":"object","properties":{"__proto__":{"type":"integer"}}}',
);
assert.throws(
  () => parseExtension(unsupported).select(contractId, 'output', 'answer'),
  (error) => error instanceof ContractError && error.code === 'UNSUPPORTED_KEYWORD',
);
console.log('PASS installed offline core discovery, text input, JSON output and rejection.');
