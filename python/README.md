# A2A Schema Contract for Python

An independent, typed implementation of the pinned Schema Contract community
draft. The inline and prepared external-resource profiles support catalog and skill discovery, original schema
inspection, explicit invocation, validation at both peers, atomic HTTP/SSE output,
continuation and cancellation through public `a2a-sdk==1.2.2` hooks.
Frameworks and models stay in application or independent adapter packages.

`0.1.0.dev0` is a local development artifact, not a release candidate. SDK-011
adds explicit secure HTTPS resolution and disposable validation processes at async
boundaries. Cross-language reference acceptance and publication are later gates.

## Install and run

CPython 3.11–3.14. Applications use pip; uv is a development tool.
Build the local artifact with `uv build` from this directory.

```sh
# Offline catalog/schema/payload APIs:
python -m pip install dist/a2a_schema_contract-0.1.0.dev0-py3-none-any.whl
# Official A2A client:
python -m pip install 'dist/a2a_schema_contract-0.1.0.dev0-py3-none-any.whl[a2a]'
# Server and complete example:
python -m pip install 'dist/a2a_schema_contract-0.1.0.dev0-py3-none-any.whl[server]' uvicorn==0.42.0
python examples/inline_demo.py
```

[The complete example](examples/inline_demo.py) runs a deterministic agent over
real loopback HTTP/SSE, with typed input and discovered skill/schema invocation.
It uses installed public imports and needs no model credentials. Artifact checks
copy and execute it outside the checkout against a noneditable wheel installation.

Runtime uses `jsonschema==4.26.0`, `referencing==0.37.0` and HTTP-framing library
`h11==0.16.0`. The `a2a` extra
adds the official SDK; `server` adds its HTTP-server dependencies. The root import
loads no vendor/framework, changes no environment and performs no network access.

## Typed invocation

The application defines business types when it knows the contract. Runtime
validation still checks the complete original input and peer result.

```python
from typing import TypedDict
from a2a_schema_contract.client import ContractClient, ContractResponse

class EchoInput(TypedDict):
    text: str

async def typed_call(base_url: str) -> ContractResponse:
    request: EchoInput = {"text": "Hello"}
    async with await ContractClient.discover(base_url) as client:
        invocation = client.prepare("urn:example:contract:echo:1", input=request)
        result = await client.invoke(invocation)
        if result.payload is not None and result.payload.present:
            value = result.payload.value  # detached, validated JsonValue
        return result
```

Discovery does not manufacture a static output type. Your explicit parser or
generated client can turn validated JSON into a business object. Convert trusted
dataclass/Pydantic objects explicitly; passing them directly is refused.
TypedDict values are ordinary dictionaries at runtime.

## Skill and schema discovery

`describe()` reports all contracts, skill associations, unsupported representation
diagnostics, stale associations and unassociated contracts. A caller or LLM
chooses a skill/contract and representation from these descriptors. The SDK
resolves the advertised association and exposes the original inline schema.

```python
from collections.abc import Callable
from a2a_schema_contract.client import ContractClient, ContractResponse
from a2a_schema_contract.core.models import PreparedSchema

async def discovered_call(
    base_url: str,
    skill_id: str,
    build_input: Callable[[PreparedSchema | None], object],
    contract_id: str | None = None,
) -> ContractResponse:
    async with await ContractClient.discover(base_url) as client:
        description = client.describe()  # descriptors for your selector
        contract = client.bind_skill(skill_id, contract_id)
        schema = client.catalog.schema(contract.id, "input", "json")
        request = build_input(schema)  # typed builder or application-owned LLM
        return await client.invoke(client.prepare(
            contract.id, input=request, input_representation_id="json",
            accepted_output_representation_ids=["json"],
        ))
```

This example explicitly chooses JSON. Choose representation IDs from discovery
for unfamiliar contracts. Multiple associated contracts require an explicit
contract ID; multiple supported representations require explicit selection.
Unsupported alternatives remain inspectable. No implicit routing, framework
dispatch or LLM invocation occurs.

By default `prepare()` requires an explicit output representation when more than
one is supported. To let the peer choose among the advertised supported outputs,
pass `allow_server_selection=True` instead of an accepted-ID list. The client
still verifies the returned representation against the catalog and any accepted
media modes, and validates the result against that representation's schema.

## Server integration

Construct an ordinary public AgentExecutor and AgentCard, then
`ContractServer(card=card, catalog=catalog, executor=executor, required=True)`.
The server validates and advertises the catalog. Mount `create_app(server)`
from `a2a_schema_contract.http`: it uses official A2A JSON-RPC route factories,
with 0.3 compatibility disabled. Mounting `server.handler` directly bypasses
the original-wire admission layer.

Inside execute, `server.execution(context)` returns immutable input
presence/value, negotiated output, task/context IDs and a cancellation signal.
`output_part`, `output_artifact` and `output_message` validate business output
before protobuf construction. Emit ordinary SDK Tasks/events. The
[provider example](examples/inline_demo.py) contains the complete wiring.

Invalid input never reaches the executor. Candidate output is retained until the
complete result/event sequence validates. A safe initial working Task without
artifacts/history can be published immediately; remaining events and artifacts
are staged and validated together. Invalid output becomes a sanitized failed
Task/status with no contracted Artifact. Catching an enqueue rejection cannot
repair a poisoned publication gate. Late events and expired output helpers fail.

Supported RPCs: SendMessage, SendStreamingMessage, GetTask and CancelTask, plus
public Agent Card discovery. Push, subscriptions, list methods, extended cards,
immediate return and auth-required execution are refused. Input-required Tasks
resume only under their retained contract/output binding; concurrent turns on
one Task are refused. Cancellation admitted before output publication reserves
the gate before application cleanup awaits. Once publication begins, cancellation
is refused for that commit; validated output cannot become a canceled partial result. Optional nonactivated calls contain no extension-owned
markers; the executor owns their ordinary behavior.

## Presence and binding

MISSING is absence; None is present JSON null. Required allows exactly one primary,
optional zero or one, and none zero. Empty strings/arrays/objects are present.
Companions remain unselected even with the same media type. No-input calls carry
an ordinary unmarked trigger Part; no-output success is a completed Task.
Optional output can be absent.

JSON and text/plain with supported exact UTF-8 media parameters are supported.
Binary/URL companions cannot supply contracted JSON/text. Python preserves root
data:null; the accepted Node 1.3.0 carrier rejects it. Do not wrap null to evade
that difference. Protobuf numbers may return as floats: 1 and 1.0 share JSON
Schema integer semantics; booleans do not.

| Identity | Placement under the extension URI |
| --- | --- |
| Invocation | SendMessageRequest.metadata |
| Primary | Part.metadata |
| Result | Task/standalone Message.metadata; terminal status metadata in SSE |
| Failure | Failed Task/status metadata, sanitized OUTPUT_CONTRACT_VIOLATION |

Input Message.metadata cannot substitute for operation metadata. Conflicting
placements/echoes are refused. Activation adds A2A-Extensions and A2A-Version 1.0
while preserving other extension headers and caller metadata. Output acceptance
intersects representation IDs with media modes; any admissible peer choice is valid.

## Ownership and authentication

Clients are async context managers; close is idempotent. A supplied HTTPX client
remains application-owned, including auth, cookies, hooks and default headers.
Discovery uses that client. Each stream owns a guarded transport scope.
Use `contextlib.aclosing(client.stream(invocation))` when breaking iteration early.
Business output appears only on ClientEvent.result after the complete bounded
stream validates; progress carries no validated business result. Truncation fails.

GetTask returns an immutable, wire-guarded inspection document; use invoke or
stream.result for contract-validated business results. CancelTask explicitly
requests remote cancellation. Local coroutine/iterator cancellation aborts HTTP
consumption without automatically issuing CancelTask. Closing a client releases
its streams and its own HTTP client, while preserving a borrowed client.

The server owns publication state and its official handler. ASGI lifespan closes
it; explicit async context/close also works. Applications own executors, model/tool
resources, supplied TaskStores, authentication and retention. Default in-memory
storage scopes records by trusted tenant and principal. Authenticate before the
routes. A public ServerCallContextBuilder must derive user/tenant from verified
host credentials. The adapter captures the trusted tenant before SDK dispatch:
caller JSON cannot select another tenant. Custom stores must enforce equivalent
authorization and globally unique task IDs; multi-process persistence is host-owned.

Discovery chooses an advertised JSONRPC 1.0 interface on the requested origin.
An explicit advertised endpoint permits intentional cross-origin use. Redirects
are refused; the configured HTTP client owns connection/auth policy. Disable
upstream SDK debug/request-body logging for protected payloads. This package
does not configure a global logger.

## Validation, limits and errors

Only exact JSON builtins are accepted. Snapshots detach trees without conversion
hooks, defaults, coercion or property removal. UTF-8 admission rejects duplicate
keys, unsafe/nonfinite numbers, null scalar fields and invalid oneofs before SDK
normalization. Formats/content are annotations. Bounded Draft 2020-12 supports
object/Boolean schemas and native local references. Unsupported dialects,
required vocabularies, keywords and external refs fail during preparation.
Schema views retain original descriptors/resources and regex spelling.

| Bound | Inline limit |
| --- | --- |
| JSON tree | depth 32; 4,096 nodes; 262,144 bytes; strings 8,192 characters |
| Schema | 256 schemas; 128 references; ASCII patterns 128 characters |
| Parts/events | 128 Parts; 128 candidate events; 262,144 candidate/SSE bytes |
| Execution | at most four executions; cooperative deadline at most 30 seconds |
| Numbers | finite binary64; integers within ±(2**53−1); positive integer multipleOf |

Validation runs synchronously on the calling thread with structural bounds.
It has no hard CPU deadline/isolation promise. Executor deadlines are cooperative;
they cannot stop code that blocks the loop or suppresses cancellation. External
HTTPS resources, process isolation, resolver/operational guarantees and prepared
external graphs belong to SDK-011. Inline acceptance does not imply those guarantees.

ContractError exposes sanitized code, origin and optional frozen detail.
Official typed A2A rejections retain sanitized messages and recognized,
request-correlated contract detail. Transport/discovery errors become sanitized
ContractError. Failed/input-required execution has payload=None; absent successful
output has AbsentPayload(present=False). Existing draft wire codes remain unchanged.

## Public modules and verification

| Module | Responsibility |
| --- | --- |
| core / core.models | JSON, presence, immutable values, limits and errors |
| catalog / discovery | catalog validation, inline schema views, capabilities, skill association |
| payload / binding / events | identity, negotiation, result validation/publication policy |
| validation / ports | offline validator and small typed port |
| client | discover, describe, bind_skill, prepare, invoke, stream, task access and close |
| server / http | executor/handler integration and guarded ASGI mounting |
| adapters / resources | optional vendor boundaries and seven installed pinned schemas |

```sh
uv sync --locked --all-extras --python 3.12
uv run ruff format --check src tests scripts examples
uv run ruff check src tests scripts examples
uv run mypy
uv run pytest --cov --cov-report=term-missing
uv run coverage json --include='*/core/*' --fail-under=100 -o reports/core-coverage.json
uv run python scripts/check_package.py
uv run python scripts/check_matrix.py
```

Coverage requires >=90% combined statements/branches and 100% domain core.
Shared cases, real transport, malformed peers, zero-execution, atomic publication,
ownership and installed-consumer checks are required. CI covers Linux 3.11–3.14
and macOS/Windows 3.14; configured jobs are not assumed passed. Seven draft
schemas retain original bytes/license/notice and pin
a5c007510faa3fce85190f2e76e402faf0e897ad; installed use needs no checkout.

See [architecture](../docs/python-architecture.md),
[metadata binding](../docs/metadata-binding.md),
[inline acceptance](../docs/python-inline-report.md) and [delivery plan](../PLAN.md).


## External resources and operational budgets

Supply a resolver explicitly to discover external catalogs/schema documents. HTTPS,
verified TLS and public-address admission are defaults. Configure exact origins,
pins and credentials per authentication identity; catalog URIs require an integrity
pin or an explicit administrator immutability promise. Inline discovery needs no
resolver and performs no schema retrieval.

```python
from a2a_schema_contract.client import ContractClient
from a2a_schema_contract.resolver import ContractResolver, ResolverLimits
from a2a_schema_contract.operations import ValidationOptions

async def external_call(base_url: str, contract_id: str) -> None:
    async with ContractResolver(
        allowed_origins=("https://contracts.example.org",),
        immutable_resources=("https://contracts.example.org/catalog/v1.json",),
        limits=ResolverLimits(deadline=10),
    ) as resolver:
        async with await ContractClient.discover(
            base_url, resolver=resolver, validation=ValidationOptions(deadline=2),
        ) as client:
            view = client.catalog.schema(contract_id, "input", "json")
            if view is not None:
                documents = tuple((doc.uri, doc.aliases, doc.value) for doc in view.documents)
                # A framework/model consumes these original native resources.
                assert documents
            resolver.clear_cache()  # prepared catalogs remain usable offline
```

`ContractServer` accepts the same `validation=ValidationOptions(...)` and optional
`diagnostics=` hook as the client. Discovery compilation and async client/server
validation run in fresh, owned processes; deadlines include startup and jobs are
physically reaped on completion or cancellation. Synchronous `prepare`, `select`,
direct validators and output helpers remain trusted calling-thread conveniences.
The final async boundary rechecks results before publication. CPU/model work in the
application executor remains application-owned/cooperative.

By default a server advertises its prepared catalog inline. To advertise a
catalog URI instead, resolve extension parameters with `ContractResolver` and
pass that exact prepared catalog to `ContractServer(..., catalog_delivery="external")`.
The resolver retains the validated external descriptor with the catalog snapshot;
passing an inline or independently parsed catalog for external delivery is refused.
Catalog retrieval requires a declared or locally configured integrity pin, or an
explicit administrator promise that the exact URI is immutable. A declared pin
travels in the advertisement; if the pin exists only in local resolver policy,
each consumer must configure its own trusted pin or immutability policy. An
immutability promise is an operational commitment, not a cryptographic check.

Frozen diagnostic hooks expose only operation, UUID correlation, duration, outcome
and a sanitized code. They add no telemetry service. See the
[resolver threat model, cache/resource semantics and platform limits](../docs/python-resolver-security.md).
There is no portable hard RSS limit; tested process/JSON/graph/time budgets and
platform-specific memory limits are stated there.

The complete demo also accepts the repository's **test-only** TLS fixture:

```sh
python examples/inline_demo.py tests/fixtures/tls/cert.pem tests/fixtures/tls/key.pem
```

It prepares pinned HTTPS resources with native cross-document references, then runs
the same typed/discovered real HTTP/SSE agent calls. The fixture certificate/key is
solely for deterministic loopback tests; never use it as a production trust identity.
`check_package.py` executes this and the matching Node-workload performance baseline
against a noneditable wheel outside the checkout. `check_matrix.py` repeats quality,
coverage and installed consumers across CPython 3.11–3.14.
