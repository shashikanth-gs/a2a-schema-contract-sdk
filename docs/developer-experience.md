# Using discovered contracts

The Node SDK provides ordinary application APIs that future Python and framework
adapters can implement against. No ADK, LangGraph or model dependency is needed.
The bounded JSON/text profile and resolver security policy still apply.

```js
import { discoverContractClient } from 'a2a-schema-contract/client';

const client = await discoverContractClient(agentUrl, { resolver });
try {
  const discovery = await client.describe();
  const candidates = discovery.skills.find(
    ({ skill }) => skill.id === 'flight-search',
  )?.contracts ?? [];
  // Choose deliberately: a skill can have several contracts.
  const contractId = chooseContract(candidates);
  const inputSchema = client.catalog.schema(contractId, 'input', 'json');
  inspectSchemaResources(inputSchema);
  const result = await client.invokeContract({
    contractId,
    input: { origin: 'BLR', destination: 'DEL' },
  });
  consumeValidatedResult(result);
} finally {
  await client.close();
}
```

`agentUrl`, `resolver`, the choice and consumption functions above are application
inputs, not SDK exports. External retrieval requires an explicitly configured
resolver; inline discovery needs none. Payload fields are defined by the provider's
discovered schema, not by this illustrative flight object.

## Discovery and invocation

`client.describe()` runs capability inspection in owned validation workers and
returns an immutable view containing all contracts, advertised skills and their
matching contracts, unassociated contracts and stale-association diagnostics.
Each contract description contains supported/unsupported input/output alternatives.
Many-to-many mappings are retained. Associations do not route execution.

`invokeContract()` accepts the payload directly and fills protocol metadata using
an explicit contract ID. It chooses input/output representations only when there
is one supported candidate. Otherwise supply `inputRepresentationId` and/or
`acceptedOutputRepresentationIds`; an explicit list may allow several output
alternatives for server negotiation. Local `AMBIGUOUS_SELECTION` means no request
was dispatched. Presence, schema validation, raw guards, result validation and
atomic server publication still use the original path. Input omission and JSON
null remain distinct; no implicit retries or mutation occur. The lower-level
`invoke()` and `stream()` APIs remain available for explicit selections/lifecycle.

## Schema resources

`catalog.schema(contractId, direction, representationId)` returns `undefined` for
a schemaless representation, or a frozen `{ descriptor, entry, documents }` view.
Documents retain original schema values and their registration identities, including
retrieval/redirect aliases. Entry may include a fragment. The original `$id`, refs,
anchors and Boolean schemas are preserved; the graph is not flattened.

Inspection performs no network access or validator compilation. For raw inline
catalogs it is a source view: use representation capabilities or validation to
establish supported schema semantics. For resolver-prepared catalogs the graph
is the acquired/checked resource snapshot, usable after cache clearing and worker
cleanup. It contains no credentials, mutable cache or compiled validator. It does
not assert that a particular model supports the full schema.

## Advertisement

`createContractExtension(catalog, options)` from `/core` builds a portable validated
AgentExtension without loading the official A2A peer. `advertiseContracts()` and
`createContractServer()` preserve the host card and unrelated extensions.

For external advertisement, first acquire the catalog through
`resolver.resolveExtensionParams({ catalog: { uri, mediaType: 'application/json',
integrity } })`, then pass that prepared catalog and `catalogDelivery: 'external'`
to `createContractServer()`. The SDK advertises the acquired reference; arbitrary
references cannot be attached to a different prepared catalog. Resolving a local
catalog with external schema documents alone does not establish external-catalog
provenance. Embedded delivery is the default. See the executable
[external example](../js/examples/external.mjs) and [metadata binding](metadata-binding.md).

Synchronous `describeContracts()` and `selectInvocation()` from `/core` support
trusted offline applications without the optional A2A peer. These may compile
validators synchronously. Network-facing client helpers use bounded owned workers.
Both use runtime-validated JSON values rather than asserting invented domain types.
