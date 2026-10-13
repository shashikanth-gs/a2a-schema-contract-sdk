# Python architecture and foundation decisions

Date: 2026-10-13. Task: SDK-009. Source draft and Node RC1 semantics remain unchanged.

## Dependency direction

The package is a Python `src/` distribution, not a translated TypeScript module
tree. `core` owns JSON values, presence, immutable error context, identifiers,
limits and exact media semantics. It imports only the standard library. `ports`
defines the small typed validator interface. `validation` implements that port
using jsonschema/referencing and installed offline resources. Optional `adapters`
contain official A2A protobuf conversion; no SDK object enters the domain layer.
Client/server application services will compose these boundaries in SDK-010;
resolver/worker infrastructure enters through explicit seams in SDK-011.

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
are the selected integration hooks. The default route profile will disable 0.3
compatibility. Invocation identity stays in operation metadata, primary identity
in Part metadata, and result echo in Task/Message/final status metadata.

Original wire JSON must be guarded before protobuf parsing. For example a null
`filename` can disappear during official parsing, while conflicting oneof fields
are rejected. This cannot replace original-value validation. An HTTP adapter will
need raw admission before the official route deserializer; Part helpers alone are
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
All vendor errors become sanitized ContractError diagnostics with the existing
draft mapping; protected data and validator messages are never retained as causes.

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
preflight. They do not claim a hard execution deadline. Worker process isolation,
owned cleanup, external resource policy and operational guarantees belong in
SDK-011; unsafe network/thread convenience fallbacks are forbidden.

## Primary research sources

- [Published SDK metadata](https://pypi.org/project/a2a-sdk/1.2.2/), inspected wheel
  and exact installed hook/carrier tests (`python/tests/test_a2a_probe.py`).
- [Official A2A 1.0 migration guide](https://github.com/a2aproject/a2a-python/blob/main/docs/migrations/v1_0/README.md).
- [jsonschema reference handling](https://python-jsonschema.readthedocs.io/en/stable/referencing/).
- [PyPA pyproject specification](https://packaging.python.org/en/latest/specifications/pyproject-toml/)
  and [src-layout guidance](https://packaging.python.org/en/latest/discussions/src-layout-vs-flat-layout/).

Published artifacts and executable probes take precedence over unversioned examples.
