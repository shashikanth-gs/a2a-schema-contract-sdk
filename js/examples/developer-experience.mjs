import assert from 'node:assert/strict';

import {
  createContractExtension,
  describeContracts,
  JSON_SCHEMA_DIALECT,
  parseCatalog,
  selectInvocation,
} from 'a2a-schema-contract/core';

const id = 'urn:example:flight-search:1';
const representation = {
  id: 'json',
  mediaType: 'application/json',
  schema: {
    mediaType: 'application/schema+json',
    dialect: JSON_SCHEMA_DIALECT,
    inline: {
      type: 'object',
      required: ['origin'],
      properties: { origin: { type: 'string' } },
      additionalProperties: false,
    },
  },
};
const catalog = parseCatalog({
  contracts: [
    {
      id,
      skillIds: ['flight-search'],
      input: { presence: 'required', representations: [representation] },
      output: { presence: 'required', representations: [representation] },
    },
  ],
});
const discovered = describeContracts(catalog, [{ id: 'flight-search', name: 'Find flights' }]);
assert.equal(discovered.skills[0].contracts[0].contract.id, id);
assert.equal(discovered.skills[0].contracts[0].input[0].supported, true);
const schema = catalog.schema(id, 'input', 'json');
assert.deepEqual(schema.documents[0].value.required, ['origin']);
assert.equal(Object.isFrozen(schema.documents[0].value), true);
const selected = selectInvocation(catalog, { contractId: id, input: { origin: 'BLR' } });
assert.deepEqual(selected.input, { representationId: 'json', value: { origin: 'BLR' } });
assert.deepEqual(selected.acceptedOutputRepresentationIds, ['json']);
assert.throws(() => selectInvocation(catalog, { contractId: id, input: {} }), {
  code: 'INSTANCE_INVALID',
});
assert.equal(createContractExtension(catalog).params.catalog.inline.contracts[0].id, id);
console.log(
  JSON.stringify({
    result: 'PASS',
    checks: [
      'skill-contract-discovery',
      'immutable-schema-resources',
      'explicit-compact-selection',
      'invalid-input-refusal',
      'portable-advertisement',
    ],
  }),
);
