# Python architecture and decisions

Updated: 2026-10-14. Tasks: SDK-009/010/011. Draft and Node RC1 semantics remain unchanged.

## Dependency direction

The package is a Python `src/` distribution, not a translated TypeScript module
tree. `core` owns JSON values, presence, immutable error context, identifiers,
limits and exact media semantics. It imports only the standard library. `ports`
defines the small typed validator interface. `validation` implements that port
using jsonschema/referencing and installed offline resources. Optional `adapters`
contain official A2A protobuf conversion; no SDK object enters the domain layer.
Catalog/discovery/payload/binding/events compose these boundaries in SDK-010.
Optional client/server/HTTP adapters integrate public vendor hooks;
resolver/worker infrastructure supplies explicit bounded acquisition and async isolation in SDK-011.

Architecture tests enforce the core import boundary. The root exposes lightweight
types/constants and cannot import the validator, transport, official SDK or a
framework. There is no generic orchestration registry, base service hierarchy,
provider plugin system or alternate protocol implementation in the foundation.
New frameworks consume public application APIs in separate packages.

## ADR-P01: Supported engineering profile

CPython 3.11–3.14, bounded below 3.15 until checked. Python 3.11 supplies idiomatic
async timeout/task lifecycle primitives; standard asyncio owns future services.
PEP 517/518/621, hatchling 1.32.4, PEP 440 `0.1.0.dev0`, SPDX Apache-2.0,
installed `py.typed`, explicit schema resources and wheel/sdist checks replace the
scaffold. End users use pip; uv 0.12.1 owns the committed development lock.
Ruff is the single formatter/linter, strict mypy the single type checker, pytest
the test runner. Explicit pytest-asyncio mode and timeouts prevent silent coroutine
tests and unbounded waits. Coverage is combined statement/branch >=90%.

Exact initial validator and optional A2A versions are deliberate: compatibility
with a different artifact is a support decision backed by new probes. Transitive
development dependencies are hash-locked. Optional upstream SDK dependencies use
its published requirements; installed-package/security checks record the tested
resolution. Do not claim its arbitrary future dependency range was validated.

## ADR-P02: Published A2A SDK compatibility

The actual `a2a-sdk==1.2.2` wheel implements A2A 1.0 using protobuf messages;
legacy examples from the 0.3 Pydantic SDK are not its public API. Published
`ClientFactory`, `ClientCallContext`, `JsonRpcTransport`, `RequestContext`,
`AgentExecutor`, `EventQueue`, `DefaultRequestHandler`, and public route factories
are the selected integration hooks. The default route profile disables 0.3
compatibility. Invocation identity stays in operation metadata, primary identity
in Part metadata, and result echo in Task/Message/final status metadata.

Original wire JSON must be guarded before protobuf parsing. For example a null
`filename` can disappear during official parsing, while conflicting oneof fields
are rejected. This cannot replace original-value validation. The HTTP adapter supplies
raw admission before the official route deserializer; Part helpers alone are
not a complete untrusted server boundary.

Root `data:null`, empty oneof text, scalar/array/object data and nested null survive
the Python carrier. JS 1.3.0 rejects root null: cross-language support must report
that difference instead of wrapping values. Struct/Value numbers become binary64;
safe finite bounds are checked before conversion and `bool` never becomes integer.
Local transport coroutine cancellation propagates and cleans up; it is not a
remote cancellation request. Framework/client ownership must remain explicit.

## ADR-P03: Data, types and errors

Use exact JSON builtins at external boundaries and return detached copies. Do not
implicitly serialize a Mapping, dataclass, Pydantic object, tuple, or subclass.
`MISSING` is an Enum singleton, distinct from None and stable across deepcopy and
pickle; use it for absent input/output. Frozen slotted dataclasses hold configuration
and error context. Neither generics nor runtime discovery infer business types.
Transport/discovery errors become sanitized ContractError. Official typed A2A
rejections retain sanitized messages and recognized request-correlated draft
detail. Protected data and validator messages do not enter public diagnostics.

## ADR-P04: Validation and resources

Use jsonschema 4.26.0 and referencing 0.37.0. No deprecated RefResolver or automatic
network retrieval. The portable profile independently implements Node's accepted
keywords, vocabularies, ASCII regex grammar, safe numeric bounds and annotation
semantics. Preflight validates schema structure and reference availability before
instance use. Shared cases compare decisions rather than vendor message wording.
Python's `$` anchor accepts a terminal newline; the accepted ECMA-262 profile does
not. A private compilation projection translates it to Python's strict end anchor,
preserves literal escapes/classes, and rewrites pointer refs when pattern-map keys
change. Public schemas remain original. Regression cases cover property evaluation,
relative/nested resource IDs, pointer aliases and recursive dynamic anchors.
Installed canonical schemas retain exact bytes/hash provenance and attribution.

Synchronous validators are trusted calling-thread APIs with bounded data/schema
preflight. They do not claim a hard execution deadline. SDK-011 supplies worker process isolation,
owned cleanup, external resource policy and explicit operational budgets;
unsafe network/thread convenience fallbacks are forbidden.

## Primary research sources

- [Published SDK metadata](https://pypi.org/project/a2a-sdk/1.2.2/), inspected wheel
  and exact installed hook/carrier tests (`python/tests/test_a2a_probe.py`).
- [Official A2A 1.0 migration guide](https://github.com/a2aproject/a2a-python/blob/main/docs/migrations/v1_0/README.md).
- [jsonschema reference handling](https://python-jsonschema.readthedocs.io/en/stable/referencing/).
- [PyPA pyproject specification](https://packaging.python.org/en/latest/specifications/pyproject-toml/)
  and [src-layout guidance](https://packaging.python.org/en/latest/discussions/src-layout-vs-flat-layout/).

Published artifacts and executable probes take precedence over unversioned examples.

## ADR-P05: Original-wire admission and public hooks

The optional HTTP boundary admits bounded UTF-8 JSON before official deserialization.
It uses public protobuf descriptors to check camelCase field names, original scalar
types, enum names, oneof cardinality, maps, arrays and timestamps. Struct/Value JSON
remains original JSON; null is valid there but not in unrelated scalar/message
fields. Business identity, presence, negotiation and schema rules remain in the
protocol-independent services. The guarded routes restrict dispatch to the claimed
four JSON-RPC methods; callers cannot bypass tenant admission through another method.

DefaultRequestHandler owns A2A Task aggregation, subscriptions and cancellation;
a public EventQueue subclass stages candidate execution events. After the complete
sequence validates, events publish to the official queue. Only a safe initial
WORKING Task without history/artifacts publishes early. No protocol internals,
private registries or monkeypatching are used. Failure is a sanitized failed Task
with no primary artifact; swallowed queue errors poison the complete turn.

## ADR-P06: Ownership and trusted request scope

Clients use the official public JsonRpcTransport and A2ACardResolver through an
HTTPX transport bridge. The bridge uses public build_request/send hooks to preserve
application authentication, headers, cookies and event hooks. Incremental response
admission occurs before protobuf decoding. Each SSE call owns a separate guarded
scope: upstream iterator closing alone did not immediately close its nested HTTP
response in the probe. Closing a stream/client deterministically releases owned
responses while a borrowed client remains open. Local abort never silently issues
a remote CancelTask request.

The SDK dispatcher replaces context.tenant with caller params. The context-builder
wrapper captures the host-authenticated tenant first; handlers restore it and reject
conflicting wire claims before execution/read/cancel. Default TaskStore ownership
combines tenant and principal. Custom persistence remains host-owned and must retain
equivalent authorization/global Task-ID uniqueness. No tenant or principal is inferred
from model input. Execution gates are request-scoped and continuation binds the same
contract/output selection. Business deadlines are cooperative; schema validation uses disposable SDK-011 processes.

## ADR-P07: Discovery and immutable public data

Frozen domain objects hold private JSON snapshots. Inspection returns new ordinary
JSON trees. Catalog/schema/resource views preserve source spelling and do not reveal
private regex projections or vendor validators. Skill IDs are advertised associations;
unknown/stale associations remain visible, and ambiguous contracts/representations
require explicit caller selection. Client prepare builds ordinary A2A request metadata
and a marked primary Part after validation, with MISSING distinct from present null.
No dynamic schema manufactures a static business type. LLM/framework selection,
request generation and framework execution remain outside this SDK.


## ADR-P08: Explicit acquisition and disposable validation processes

Use an instance-owned HTTPS resolver rather than borrowing application HTTP clients
or installing a vendor reference loader. Every DNS answer is admitted, then a fresh
TLS connection binds the first approved numeric address to verified original-host
SNI/Host/certificate identity. Public asyncio/SSL APIs own networking and h11 0.16.0
owns HTTP framing. Exact origin/authentication/pin/immutability configuration and
bounded private caches isolate security identities. Default DNS uses an owned process;
custom async lookup is a trusted host seam with cooperative cancellation.

Native schema graphs preserve original document/descriptor/base/ref semantics in
immutable prepared views. Redirect aliases and schema identities are normalized only
for private registry/regex compilation. Schema-position inspection prevents refs into
annotations; an explicit offline referencing registry cannot acquire more documents.
Prepared inspection requires no retrieval/compilation and survives cache clear/closure.
Synthetic inline URNs hash structured contract/direction/representation identities,
avoiding delimiter collisions and expansion beyond URI-string budgets.

Async client/server input/result/publication gates, discovery compilation and resolver
compilation use fresh `-I -S -B` interpreters. The fixed JSON protocol excludes pickling,
application callbacks/environment/import paths and arbitrary operations. Default
2-second deadlines include startup; capacity is refused above four jobs. Acquisition
is shielded and physical termination awaited on every exit path, including repeated
cancellation while acquiring a child. No timed-out job falls back to the event loop
or an unkillable executor thread. Sync helpers remain explicit trusted conveniences.

Python OS memory controls differ from Node's V8 limit and from each other. POSIX
stack bounds and Linux data-segment bounds are documented separately from portable
wall/data/schema budgets. macOS/Windows do not claim an OS RSS ceiling. Hosts needing
strict RSS enforcement own deployment/container/job controls. Frozen allowlisted
correlation hooks are optional and add no telemetry dependency.

[Resolver/operations threat model](python-resolver-security.md) records exact limits,
public API ownership, primary references, tests and installed benchmark methodology.
The benchmark workload matches Node's bounded-count object and records samples per
interpreter; message wording/performance across unlike hosts is not a parity claim.
Hosted platform checks and four peer pairings remain distinct acceptance evidence.
