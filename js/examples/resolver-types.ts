import {
  createContractResolver,
  type ContractResolver,
  type ResolverOptions,
  type Address,
} from 'a2a-schema-contract/resolver';
import type { ContractCatalog, JsonValue } from 'a2a-schema-contract/core';

const options: ResolverOptions = {
  allowedOrigins: ['https://contracts.example.org'],
  resourceIntegrity: {},
  limits: { responseBytes: 65536, cacheEntries: 8 },
};
const resolver: ContractResolver = createContractResolver(options);
const address: Address = { address: '1.1.1.1', family: 4 };
async function prepare(params: unknown, signal: AbortSignal): Promise<ContractCatalog> {
  return resolver.resolveExtensionParams(params, { signal });
}
async function validate(params: unknown, signal: AbortSignal): Promise<JsonValue> {
  const catalog = await prepare(params, signal);
  return catalog.select('urn:example:1', 'input', 'json').validate({ count: 1 });
}
// @ts-expect-error A schema resolver is opt-in, never an unvalidated discovered domain type.
const domain: { count: number } = {} as JsonValue;
void [address, validate, domain];
