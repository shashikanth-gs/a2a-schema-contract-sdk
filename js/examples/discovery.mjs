import {
  EXTENSION_URI,
  parseExtension,
  encodePrimary,
  validateInvocation,
} from '@shashikanth-gs/a2a-schema-contract/core';

const contractId = 'urn:example:contract:unknown-domain:1';
const catalog = parseExtension({
  uri: EXTENSION_URI,
  params: {
    catalog: {
      inline: {
        contracts: [
          {
            id: contractId,
            input: {
              presence: 'required',
              representations: [{ id: 'json', mediaType: 'application/json' }],
            },
            output: { presence: 'none' },
          },
        ],
      },
    },
  },
});
const selected = catalog.select(contractId, 'input', 'json');
const part = encodePrimary(selected, { nested: null }, 'a2a-js-1.3.0');
const invocation = validateInvocation(
  catalog,
  {
    [EXTENSION_URI]: { contractId, inputRepresentationId: 'json' },
  },
  [part],
  'a2a-js-1.3.0',
);
console.log(invocation.input.present);
