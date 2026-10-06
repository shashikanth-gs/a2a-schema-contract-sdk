import {
  type ContractDiscovery,
  createContractExtension,
  describeContracts,
  type JsonValue,
  parseCatalog,
  type PreparedSchema,
  selectInvocation,
} from 'a2a-schema-contract/core';

const catalog = parseCatalog({
  contracts: [
    {
      id: 'urn:example:flight-search:1',
      input: {
        presence: 'required',
        representations: [{ id: 'json', mediaType: 'application/json' }],
      },
      output: { presence: 'none' },
    },
  ],
});
const discovered: ContractDiscovery = describeContracts(catalog, [{ id: 'flight-search' }]);
const schema: PreparedSchema | undefined = catalog.schema(
  'urn:example:flight-search:1',
  'input',
  'json',
);
const extension = createContractExtension(catalog, { required: true });
const selected = selectInvocation(catalog, {
  contractId: 'urn:example:flight-search:1',
  input: { origin: 'BLR' },
});
const value: JsonValue | undefined = selected.input?.value;
// @ts-expect-error Dynamic validation does not establish a domain-specific TypeScript type.
const domain: { origin: string } = value;
if (schema) {
  // @ts-expect-error Resource documents are immutable.
  schema.documents[0] = { uri: 'urn:example:other:1', value: true };
}
void [discovered, schema, extension, selected, domain];
