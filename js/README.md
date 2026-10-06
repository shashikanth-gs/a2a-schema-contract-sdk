# JavaScript / TypeScript SDK

Release candidate `a2a-schema-contract@0.1.0-rc.0` implements the
inline JSON/text core, official A2A 1.3.0 JSON-RPC/HTTP/SSE adapters and explicit
secure HTTPS catalog/schema resolution. Async transport boundaries and resolver
compilation use owned validation workers with enforceable limits. Install the
reviewed tarball; npm publishing remains disabled. Python remains a scaffold.

Use patched Node **22 >=22.23.3** or **24 >=24.21.0**, npm and ESM. CommonJS,
browsers and other runtime lines are unsupported. The optional official SDK peer
is exactly 1.3.0. Core installs without that peer, Express or provider packages.

```sh
npm ci
npm run check
npm run check:clean
npm pack
```

`check` verifies formatting, lint, strict types, the pinned source/build, behavioral
coverage and an isolated installed tarball consumer. Core thresholds remain 100%
for statements/branches/functions/lines. Aggregate thresholds are 90% statements,
90% branches, 95% functions and 95% lines; the integration group additionally has
80% statements/branches and 90% functions/lines. Resolver thresholds are
95% statements/lines, 90% branches and 100% functions. Integration guarantees are tested
through actual HTTP/SSE and explicit execution/publication assertions; coverage is
an additional regression gate, not a substitute for those assertions.
`check:clean` repeats all gates in a temporary source copy without prior builds,
installed dependencies or workspace inputs. `reports/rc-*` and
`artifacts/rc-node{22,24}` record exact runtimes, coverage and hashes.
Prior resolver, integration, core and foundation evidence is retained.
Candidate hosted evidence is recorded separately in the repository release report.

## HTTP client/server quickstart

Install the tarball and the exact peer into an application. Express is the host's
choice and is not a runtime dependency of this package:

```sh
npm install /absolute/path/to/a2a-schema-contract-0.1.0-rc.0.tgz @a2a-js/sdk@1.3.0 express@5.1.0
node http.mjs
```

Copy [the complete quickstart](examples/http.mjs) into your application. It starts
a local server on a dynamic port, discovers the contract, doubles `{count:4}`,
checks local and wire rejection, proves invalid output has no Artifact, consumes
an atomic SSE result and closes the server. The installed-consumer gate executes
this exact file. [The strict TypeScript example](examples/http-types.ts) is compiled
against installed public declarations.

```js
import { discoverContractClient } from 'a2a-schema-contract/client';
const client = await discoverContractClient('http://localhost:8080', {
  signal: AbortSignal.timeout(5000),
});
const contract = client.catalog.getContract('https://contracts.example.org/double/1.0');
const inputSchema = contract.input.representations[0].schema.inline;
const result = await client.invoke(
  {
    contractId: contract.id,
    input: { representationId: 'json', value: { count: 4 } },
  },
  { signal: AbortSignal.timeout(5000) },
);
if (result.payload?.present) console.log(result.payload.value);
void inputSchema;
```

Discovery validates inline catalogs by default; pass `resolver` to prepare an external catalog/schema graph. The URL factory chooses only
A2A 1.0 JSON-RPC and guards raw responses before protobuf normalization. A
configured official `Client` can instead be passed to `createContractClient(client,
discoveryOptions?, resolver?, validationOptions?)`, preserving its fetch, authentication, interceptors and call
context. Its transport must use `guardResponseFetch(applicationFetch)` to protect
raw JSON and SSE carrier exclusivity/types before the official codec. Discovered
schemas are runtime data; no generic domain type is inferred.

`ContractClient.prepare(options)` validates and builds a `SendMessageRequest`.
`invoke(options, requestOptions?)` returns `{response,payload}`; `payload` is
`{present:false}` for a successful omission, `{present:true,value,representationId,
part}` for a primary, or undefined for interrupted/failed/canceled/rejected Tasks.
Inspect the official Task state to distinguish these cases. `stream` is an async
generator of `{kind:'companion',event}` and `{kind:'result',result}`; output-bearing
events are withheld until the aggregate validates. Iteration and fetch readers
are canceled when the caller aborts or closes the iterator.

Invocation options: `contractId`; optional `input:{representationId,value}`;
`acceptedOutputRepresentationIds`; non-primary wire-shape `companions`;
application `configuration`/`metadata`; and `taskId`/`contextId`/`tenant`. Omission
of `input` is absence; empty string/object/array and nested null remain present.
A no-input invocation supplies a real companion trigger when needed. Invocation
metadata is owned by the helper at operation scope; duplicate Message placement
and application replacement of the namespace are refused. Empty accepted-ID
lists fail the published invocation schema. Absent/empty protobuf output-mode
lists impose no media restriction; nonempty lists use exact media matching.
The server chooses the first supported catalog alternative satisfying both lists.
The client accepts any peer choice satisfying both lists and independently
validates that chosen schema; catalog order is not a client-side protocol rule.

Server APIs are `advertiseContracts(card,catalog,required?)`,
`createContractServer({card,catalog,taskStore,executor,required?,signal?,deadlineMs?})`,
`adapter.execution(requestContext)`, `outputPart(execution,value)` and
`outputArtifact(execution,value,artifactId?)`. `execution` provides validated
input, invocation, negotiated output and an abort signal. The application uses
its own TaskStore and business executor; the adapter adds no orchestration store.
Use public official `AgentEvent` and protobuf constructors. When building
`Task.fromJSON`, supply `Artifact.toJSON(artifact)` rather than an internal
protobuf Artifact object. The server adds the result echo on Task completion;
standalone Message executors supply their own result echo.

Mount **all three boundaries**: `adapter.guard(req.body)` after a bounded JSON
parser and before the official `jsonRpcHandler`; `adapter.handler` as that
handler's request handler; and the wrapped executor supplied to the factory.
The raw guard rejects coerced/multiple/content-less carriers. The handler validates
input/negotiation before the official handler writes continuation history. The
execution wrapper validates output before successful publication. Missing required
activation is existing A2A -32008; optional unactivated baseline calls retain
normal A2A behavior. Contract metadata without activation and unactivated
continuations of contracted Tasks are refused. Activation and application context
remain per request.

## Lifecycle, limits and failure ownership

The supported event grammar starts with Task or standalone Message on every
execution, including continuation. A standalone Message is one complete response
and cannot fulfill no-output contracts. Tasks use unique nonempty Artifacts and
one aggregate primary. Additional Artifacts/Parts may be companions. Atomic
artifact updates require `append:false,lastChunk:true` and a new artifact ID.
Appends, replacement artifacts, partial JSON and record streams are refused.
Wrong task/context identity, duplicate primaries, conflicting echoes, events after
terminal state and unfinished executions fail without a contracted Artifact.
Primary content is forbidden in status Messages.

A safe initial WORKING Task with no Artifacts/history may pass immediately,
allowing progress visibility, storage and cancellation. Other events are bounded
and staged until the executor settles; output and final success are validated
before release. Status/companion events can be consumed through SSE, but this
checkpoint does not promise continuous token delivery. The synchronous official
bus cannot await producer backpressure: overflow fails closed. Boundary-owned
staging and client accumulation are capped at 128 events and 262144 bytes; the
underlying SDK queue therefore receives at most that bounded batch per execution.
Raw response frames/documents and core snapshots also have 262144-byte limits.
An application should bound concurrent requests and honor network backpressure.

`INPUT_REQUIRED` Tasks persist contract/selected-output association in the existing
Task metadata. Continuations must reactivate the extension, retain the contract
and negotiated output and start with a new initial Task event. Changed association,
concurrent turns and repeated calls after completion are refused before history
writes. Interrupted association is not a successful result payload. No live bus
is retained after an interrupted execution; subsequent calls use the same store.
AUTH_REQUIRED/out-of-band resumption and return-immediately are unsupported in
this inline profile.

`SERVER_LIMITS` defaults to a 30000 ms execution deadline, which trusted
`deadlineMs` may shorten to 1–30000 ms. `signal(context)` supplies an
application-owned disconnect/shutdown signal. The complete Express recipe uses a
public context builder to carry an AbortController and abort on response closure.
`execution.signal` composes that signal, the deadline and explicit CancelTask.
Executors must honor it for their own I/O/cleanup. The boundary removes active
state/listeners and discards late events; it cannot forcibly stop arbitrary
application work. Async schema boundaries are isolated in owned workers.

Caller `RequestOptions.signal` owns invocation timeout/abort; discovery uses its
own optional signal and does not retain that signal for later invocations. Transport
failures remain official SDK/fetch errors. Abort does not automatically send
CancelTask. Explicit `client.client.cancelTask(...)` remains an application
operation, authorized through the existing handler/TaskStore. No invocation retry
is introduced; application-configured auth fetch/interceptors retain their own
retry policy.

Malformed input/presence/schema errors use existing A2A -32602; unsupported
negotiated representations use -32005. When a usable contract/direction exists,
sanitized published error detail is serialized under the extension URI in existing
ErrorInfo metadata. Unknown/malformed contract scope has only a binding error.
Executor exceptions, deadline/overflow and invalid output become a failed Task
with `OUTPUT_CONTRACT_VIOLATION` under the namespace and no contracted output.
Explicit cancellation uses CANCELED. No exception text, input value, schema path
or credential is copied into failures. Optional deliberate omission succeeds;
generation failure is never converted to omission.

## Offline discovery and validation

The executable [core example](examples/core.mjs) performs discovery, empty text
input encoding, invocation validation, JSON output encoding and independent
result validation through public imports. It is run from a tarball installation
without the official peer or source checkout. To run it after installing a local
tarball:

```sh
npm install /absolute/path/to/a2a-schema-contract-0.1.0-rc.0.tgz
node core.mjs
```

```js
import {
  EXTENSION_URI,
  parseExtension,
  encodePrimary,
  validateInvocation,
} from 'a2a-schema-contract/core';

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
```

Discovery takes `unknown` and returns frozen validated catalog data. Contract
selection is explicit; `skillIds` and `supersedes` are descriptive only. A
versioned absolute ID must have an explicit numeric version segment such as
`/1.0`, `/v2` or `:1`. Relative, credential-bearing and `latest` IDs are rejected.
Immutability cannot be proven from syntax; advertisers own that promise.
Representation IDs are local to each direction and are distinct from contract,
package, protocol, extension and dialect identifiers.

Catalog structure is checked against the pinned normative schemas. Duplicate
contract IDs or representation IDs within a direction fail. Unsupported
representations remain visible in discovery; `capabilities` reports their local
diagnostic, while `select` refuses them before any payload processing. Selection
compiles and validates the private schema snapshot before returning its validator.
Dynamic validation returns `JsonValue`; it does **not** manufacture a static
business type or generic assertion.

## Public API

Root and `/core` export these functions and their readonly interfaces. No core
import reads configuration, compiles schemas, fetches resources or opens files.
There is no resolver, global logger, background worker, handle to close or retry.
Every operation is synchronous; fixed budgets below are the current configuration.

| API                                                                                               | Behavior                                                                                   |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `parseCatalog(unknown, origin = 'local')`                                                         | Structural/identifier validation; frozen `ContractCatalog`                                 |
| `parseExtensionParams(unknown, origin = 'remote')`                                                | Inline params validation; external form fails `SCHEMA_UNAVAILABLE`                         |
| `parseExtension(unknown, origin = 'remote')`                                                      | Discovered AgentExtension; requires exact extension URI and valid params                   |
| `catalog.getContract(id, origin?)`                                                                | Explicit contract lookup; no skill routing/version fallback                                |
| `catalog.capabilities(id, direction)`                                                             | Representation, schema and supported/diagnostic decision for every alternative             |
| `catalog.select(id, direction, representationId, origin?)`                                        | `PreparedRepresentation` exposing codec, original representation/schema, and `validate`    |
| `selected.validate(unknown, origin?)`                                                             | Non-mutating schema/media validation; returns frozen JSON snapshot                         |
| `encodePrimary(selected, unknown, carrier = 'json')`                                              | Validate and encode wire-shape JSON/text Part with explicit primary metadata; local errors |
| `decodePrimary(catalog, id, direction, unknownParts, representationId?, carrier = 'json')`        | Validate carriers, presence/identity/media and full instance; remote errors                |
| `validateInvocation(catalog, unknownMetadata, unknownParts, carrier = 'json')`                    | Validate operation-scope invocation, known output IDs and input selection/presence         |
| `validateResult(catalog, id, unknownMetadata, unknownParts, expectedOutputId?, carrier = 'json')` | Validate result echo and complete output, including optional/none omission                 |
| `matchMediaTypes(a, b)`                                                                           | Compare exact supported media semantics; unsupported spelling returns false                |
| `CORE_LIMITS`                                                                                     | Frozen fixed-budget profile; not environment-configured                                    |
| `getSchemaResource(name)`                                                                         | Return a local installed schema URL; reading it is the caller's explicit operation         |

`Payload` is `{ present: false }` or `{ present: true, value, representationId,
part }`. `null`, empty text/object/array, false and zero are present. Required
means exactly one primary, optional zero/one, none zero. Omission also requires
omitting its representation ID from invocation/result metadata. Same-media
companion Parts are never inferred to be primary. Any namespaced Part with
malformed or conflicting primary identity is rejected.

Part APIs accept **wire-shape Parts**, with exactly one of `data`, `text`, `raw`,
`url`, and JSON metadata. SDK-internal `content: { $case, value }` objects need an
adapter. Companion raw (base64)/URL Parts are shape-checked and never fetched or
schema-validated. Primary raw/URL carriers are unsupported. Input collections
must be nonempty. Empty output collections represent a Task without artifacts;
these APIs do not authorize an empty Message/Artifact. Binding validation of
those containers, activation, result placement, output-mode negotiation,
continuations, task storage and streaming are implemented by the adapter APIs described above.

`carrier: 'json'` preserves root null in the framework-independent core.
`carrier: 'a2a-js-1.3.0'` explicitly rejects root `data:null`, including companion
Parts, before it can be dropped by the official codec. Nested null is preserved.
Always use that profile when crossing official 1.3.0 codecs. There is no wrapping,
stringifying or implicit conversion. Default core behavior is not an adapter
compatibility claim.

## Validator and media profile

Supported primaries are exact `application/json` data Parts and `text/plain`
text Parts. Type/subtype/charset names are case-insensitive. Text charset may be
absent or UTF-8, including quoted spelling; those forms are equivalent in the
Unicode text carrier. Duplicate/unknown parameters, other charsets, JSON
parameters, vendor `+json`, wildcards, quality weights and inference are rejected.

Schema descriptors must use inline object/Boolean JSON Schema, schema media
`application/schema+json` and dialect
`https://json-schema.org/draft/2020-12/schema`. Embedded `$schema` must agree.
Schemas themselves are meta-validated before instances.
Ajv omits the exact map key `__proto__` in `properties`/`patternProperties`;
those schema entries fail `UNSUPPORTED_KEYWORD` before compilation. An anchored
`patternProperties` key `^__proto__$` can constrain that instance property.
Instance properties with special names are retained and validated. Standard core,
applicator, validation, unevaluated, metadata, format-annotation and
content-annotation vocabularies are supported. `format` (even unknown names) and
`content*` are annotations. Required format-assertion/custom vocabularies,
conflicting standard vocabulary declarations and unknown assertion keywords fail
explicitly. Optional unfamiliar vocabularies do not enable new keywords.

Ajv uses native local pointers, anchors, embedded resource IDs, and local
recursive/dynamic-anchor semantics. Relative embedded `$id` is resolved natively;
absolute root `$id` is recommended. Native dynamic refs in this checkpoint must
be fragment-local. Missing refs/external dependencies fail `SCHEMA_UNAVAILABLE`
without fetching. Direct root-only self refs fail `SCHEMA_INVALID`; evaluation
stack exhaustion or non-progressing recursive cycles fail `RESOURCE_LIMIT`.
Local recursion must consume bounded instance nesting. No asynchronous schema,
external catalog, document, bundle, XML or other dialect is silently enabled.

Only finite binary64 numbers and safe integers are supported, including schema
constants and bounds. `multipleOf` must be a positive safe integer. Negative zero
has JSON zero semantics. Undefined, BigInt, nonfinite/unsafe integers, sparse or
augmented arrays, cycles, proxies, accessors, symbols, non-JSON objects and lone
UTF-16 surrogates fail. Plain/null-prototype objects and shared acyclic values are
snapshotted without invoking getters. Validation never coerces types, inserts
defaults, removes fields or mutates caller data.

Portable patterns contain printable ASCII literals, ASCII character classes and
ranges (optional negation), anchors only at the start/end, concatenation and
simple `?`, `*`, `+`, `{m}`, `{m,n}`, `{m,}` quantifiers. Escaped syntax punctuation
must be valid under Unicode regex rules; dot is allowed only as escaped literal.
Grouping, alternation, wildcard dot, shorthand classes, backreferences, lookarounds,
Unicode properties and flags are unsupported. **At most one variable quantifier**
is allowed per pattern; fixed repetitions are allowed, with bounds <=8192.
This deliberately narrows the initial ADR to avoid overlapping repetition.

| Fixed budget                         | Maximum                                                   |
| ------------------------------------ | --------------------------------------------------------- |
| JSON nesting / visited nodes         | 32 / 4096 per boundary snapshot                           |
| Conservative JSON byte budget        | 262144 per snapshot, including keys and escaped strings   |
| String length / pattern length       | 8192 Unicode code points / 128 printable ASCII characters |
| Schema nodes / reference occurrences | 256 / 128 per selected schema                             |
| Parts                                | 128 per payload collection                                |
| Validator diagnostic volume          | First failure; no raw Ajv diagnostics exposed             |

These are preflight budgets. Explicit synchronous core calls remain on the
calling thread and have no abort/deadline control. Async transport validation and
resolver compilation additionally enforce owned worker limits, documented below.

## Errors and installed resources

`ContractError` provides a stable local `code`, `origin: 'local' | 'remote'`, safe
message and optional frozen `detail` matching the pinned draft error schema. Local
means caller configuration/value validation; remote means discovery/peer input.
No contract ID is invented before valid selection. Detail contains only draft
code, validated contract ID/direction and, when known, representation ID. It never
contains payload values, schema contents, causes, instance paths, credentials or
raw validator messages. Unsupported media/carriers map to
`REPRESENTATION_NOT_SUPPORTED`; unsupported dialect/vocabulary/profile features
to `SCHEMA_INVALID`; unavailable delivery/ref to `SCHEMA_UNAVAILABLE`. Invalid
metadata/carrier/value/profile-budget failures map to `INSTANCE_INVALID` when
scoped. This core throws errors; A2A wire errors/failed-Task mapping are implemented by SDK-004.
Caller policy controls whether locally returned schema discovery is disclosed.

Seven schemas, verified source manifest, LICENSE and NOTICE ship under exported
`/resources/*`. `getSchemaResource` checks the public name and returns a URL only.
The [resource example](examples/resource.mjs) explicitly reads it. Build verifies
33 source hashes and embeds the **verified** structures for offline parsing;
installed code needs no `inputs/`, vendor checkout or network. All other package
paths are private. To refresh the reviewed source pin from the repository root:

```sh
node scripts/snapshot-contract.mjs /path/to/specification-checkout
```

Full support/evidence: repository [support matrix](../docs/support-matrix.md),
[architecture](../docs/architecture.md), [core report](../docs/inline-core-report.md)
and [task plan](../PLAN.md). No full-draft/transport/parity claim is made.

## Explicit secure external resolution

Core parsing never retrieves documents. Import the resolver separately (it also
installs without the optional A2A peer):

```js
import { createContractResolver } from 'a2a-schema-contract/resolver';
import { discoverContractClient } from 'a2a-schema-contract/client';
const resolver = createContractResolver({
  allowedOrigins: ['https://contracts.example.org'],
  limits: { responseBytes: 65536, cacheEntries: 8 },
  // Private configuration, if needed:
  // authorization: { 'https://contracts.example.org': 'Bearer application-owned-token' },
  // resourceIntegrity: { 'https://contracts.example.org/dependency.json': {
  //   algorithm: 'sha-256', value: '<canonical base64 SHA-256 digest>',
  // } },
});
const client = await discoverContractClient('https://agent.example.org', {
  resolver,
  signal: AbortSignal.timeout(5000),
});
void client;
```

`resolver.resolveCatalog(rawCatalog, {origin: 'local', signal})` returns an
immutable `ContractCatalog`. `resolveExtensionParams(params, options)` handles
inline/external `params.catalog`; `resolveExtension(extension, options)` also
checks the exact extension URI. Origin defaults to `remote`. Preparation validates
structures and compiles every supported JSON Schema representation, including
its transitive dependencies. Unsupported bundle/dialect/media alternatives stay
visible through capability diagnostics; a failing supported schema prevents
preparation from returning a partially trusted catalog.

Pass a resolved catalog directly as `createContractServer({catalog: prepared,
...serverOptions})`; the server preserves descriptors and validates against its
private compiled graph. Resolution is an application startup step. The server
and client select and validate synchronously thereafter without retrieval. To
advertise an external catalog, set the extension's `params.catalog` on the
returned server card to the structurally valid descriptor
`{uri, mediaType: 'application/json', integrity: {algorithm, value}}` whose
published bytes contain the same contracts. Every external catalog needs a
SHA-256/SHA-512 pin or an exact administrator `immutableResources` promise.
Server schema authentication is independent of the A2A client's authentication;
provide private `authorization` for each resolver identity as needed.

HTTPS is mandatory. URL userinfo, trailing-dot hosts, backslashes/control bytes,
invalid escapes and `/latest` convenience identifiers are refused. Every DNS
answer must pass the conservative public-address classification. Optional
`allowedOrigins` is an exact list including ports; it does not override address
policy. An administrator can explicitly allow an internal endpoint with
`allowAddress(address, hostname)`; use both an exact origin list and narrow
address/hostname checks. `lookup(hostname, signal)` is a trusted custom DNS hook;
its approved address is used directly in the actual TLS connection. `ca` replaces
the default trust roots; certificate trust and original hostname checks are always
required. No `fetchImpl`, insecure TLS switch or automatic cookie/credential
forwarding is provided by the resolver.

`authorization` supports only exact-origin Authorization values. Same-origin
redirects may retain them; a cross-origin redirect removes Authorization for the
rest of that redirect chain, including a bounce back. Explicit transitive
resource requests use their own exact-origin configuration. Never share a
resolver across authentication identities. Options' arrays, maps, pins and CA
buffers are privately copied; recreate the resolver to rotate identity/policy.
Trusted callbacks remain application-owned.

| Maximum/default                       | Value           | Scope                                                               |
| ------------------------------------- | --------------- | ------------------------------------------------------------------- |
| Redirects                             | 3               | Each retrieval                                                      |
| Response bytes / aggregate bytes      | 256 KiB / 1 MiB | Document / one preparation, including cache reads                   |
| Elapsed time                          | 10 s            | One preparation's asynchronous I/O                                  |
| Documents / references / schema nodes | 32 / 128 / 256  | Preparation retrievals / individual representation graph refs/nodes |
| Reference depth                       | 8               | Individual representation document graph                            |
| Concurrent preparations               | 4               | Resolver instance; excess refused                                   |
| Cache entries / bytes                 | 32 / 1 MiB      | Resolver instance, LRU                                              |

`limits` may lower maxima only; zero disables redirects or cache entries/bytes.
Existing `CORE_LIMITS` also bound JSON depth (32), nodes (4096), strings (8192)
and schema inspection. `RESOLVER_LIMITS`, `ResolverOptions`, `ResolutionOptions`,
`NetworkPolicy`, `Address` and `ContractResolver` are exported from `/resolver`.
`resolver.cache` reports counts only; `clearCache()` discards representation bytes,
while prepared catalogs remain usable offline.

Digest canonical base64 is checked against final response body bytes after HTTP
transfer framing, before decoding/parsing. Compressed responses are refused;
identity encoding and UTF-8 JSON only. Catalog/schema response types must match
`application/json` / `application/schema+json` with an optional UTF-8 charset.
Cache keys contain the fragmentless canonical requested URI, expected document
media type and pin. Cache storage is scoped to one instance, never global or
shared across identities. Only pinned/promised documents are reused; unpinned
schema documents are acquired afresh for each preparation. Shared documents use
one coherent snapshot within that preparation; document/aggregate byte limits
count distinct URI/media/pin snapshots, including global cache reads. ETags and versioned
URLs do not prove immutability. A root digest does not pin native dependencies;
use `resourceIntegrity` keyed by their exact document URIs.

Root fragments, anchors, escaped JSON Pointers, `$id` bases/embedded resources,
relative dependencies and bounded local recursion retain native semantics.
Redirected documents use the final location as base and the original URI as an
alias. Inline schemas use a private URN base; relative network references require
an absolute `$id`. References into annotation/instance-data objects are refused.
Separate-document dependency cycles, ambiguous duplicate identities and missing
targets are refused. Non-fragment `$dynamicRef` and pointers with a percent-encoded
leading slash remain unsupported; use a literal `#/` prefix. Bundles/XML/XSD
remain unsupported. Resolver compilation uses an owned worker; trusted
synchronous prepared-catalog helpers retain the core calling-thread behavior.

Resolver failures are sanitized `ContractError`s. Local diagnostics
`RESOLUTION_POLICY`, `INTEGRITY_MISMATCH`, `RESOLUTION_ABORTED`,
`RESOLUTION_TIMEOUT`, and `REFERENCE_CYCLE` map to existing draft
`SCHEMA_UNAVAILABLE` when contract/direction context exists; they are not new wire
error codes. Byte/graph/concurrency exhaustion uses `RESOURCE_LIMIT`. Invalid
schemas use the existing schema/profile diagnostics. No raw URL, response,
credential, DNS/TLS/parser cause or signal reason is included. Client preparation
failures occur before invocation; server preparation fails before serving requests.

Run the complete local HTTPS + A2A HTTP/SSE demonstration from this checkout:

```sh
npm run build
node examples/external.mjs
```

It uses the public **test-only** certificate/key in `test/fixtures/tls/`, explicitly
allowlists a dynamic local HTTPS origin/address, verifies catalog/root/dependency
pins, proves input/output/peer refusal and confirms invocation causes no retrieval.
The installed-consumer gate copies those public fixtures separately from the
package and runs the same script. [Strict resolver declarations](examples/resolver-types.ts)
compile before installing the optional peer. The full threat model and native
reference restrictions are in [resolver-security.md](../docs/resolver-security.md).

## Isolated validation and operation

Async `invoke`/`stream`, server request/final-event validation and resolver schema
compilation run in owned workers. Defaults and hard maxima are 2,000 ms per
operation, four concurrent operations per owner, a 64 MiB V8 old-generation heap
and a 4 MiB stack. The deadline includes startup and compilation. Workers receive
no application environment or command-line flags and never retrieve schemas.
Every result/refusal/abort/timeout awaits worker termination; there is no retained
worker pool. Saturated sessions return `RESOURCE_LIMIT` with no unbounded queue.
V8 limits do not promise a hard process RSS cap; configure host memory limits too.

`discoverContractClient(url, { validation: { deadlineMs, concurrent, diagnostics } })`
and `createContractServer({ ..., validation: { ... } })` configure these limits.
Only lower values are allowed. `createContractClient` accepts validation options
as its fourth argument. `client.close()` closes its validation owner;
`server.close()` also aborts active execution controllers. Close the HTTP host
separately. Business executors and custom DNS callbacks remain application-owned
and must honor their signals. Cancellation callbacks have a bounded wait.

The `operations` public subpath supports independent isolated core validation,
including an installation without the optional official SDK peer:

```js
import { parseCatalog } from 'a2a-schema-contract/core';
import { createValidationSession } from 'a2a-schema-contract/operations';
const catalog = parseCatalog({
  contracts: [
    {
      id: 'urn:example:isolated:1',
      input: {
        presence: 'required',
        representations: [{ id: 'json', mediaType: 'application/json' }],
      },
      output: { presence: 'none' },
    },
  ],
});
const session = createValidationSession(catalog, { deadlineMs: 1000, concurrent: 2 });
try {
  const validated = await session.run(
    'validate',
    {
      contractId: 'urn:example:isolated:1',
      direction: 'input',
      representationId: 'json',
      value: { count: 2 },
    },
    { signal: AbortSignal.timeout(1500) },
  );
  console.log(validated);
} finally {
  await session.close();
}
```

`session.active` counts owned in-flight workers. `run('capabilities', {})` reports
representation capabilities using the same isolated compiler. Results remain
runtime JSON data; supplying a TypeScript result annotation does not prove a
statically known domain type. Adapter RPC operations used internally are not a
separate wire protocol. Do not construct internal resolved-schema programs.

Catalog `.select().validate()`, client `.prepare()`, and `outputPart` /
`outputArtifact` remain synchronous helpers for trusted application schemas and
values and have no enforceable deadline. Prefer async boundaries and isolated
sessions for discovered or hostile schemas. The server independently validates
all staged output before contracted publication, including manually built Parts.

`ValidationOptions.diagnostics` and `ResolverOptions.diagnostics` receive immutable
facts: operation, generated correlation ID, duration, success/rejection, and an
optional local code. Discovery measures Agent Card retrieval; negotiation and
validation have their own facts. Payloads, URLs, schemas, credentials, causes and
validator prose are absent. Hooks run synchronously and cannot change decisions
by throwing; keep them short. No logger/backend is required.

`VALIDATION_TIMEOUT` and `VALIDATION_ABORTED` are local diagnostics; existing A2A
and draft error mappings remain unchanged. A timed-out worker is terminated
before the call rejects. Requests that fail input validation cause no business
execution. Output failures release no successful contracted artifacts.

The installed-consumer gate runs the hostile deadline/abort/cleanup example,
strict operational declarations, all 20 pinned structural cases against the
shipped schemas, and repeatable cold/warm core/worker/HTTPS benchmarks. The
release rehearsal command `npm run release:rehearsal` verifies two identical packs
and a dry-run file list, without publishing or creating tags.

See the repository [operations guide](https://github.com/shashikanth-gs/a2a-schema-contract-sdk/blob/main/docs/node-operations.md),
[release policy](https://github.com/shashikanth-gs/a2a-schema-contract-sdk/blob/main/docs/node-release.md),
and [changelog](https://github.com/shashikanth-gs/a2a-schema-contract-sdk/blob/main/CHANGELOG.md).
