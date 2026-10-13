# Independent Python inline acceptance (SDK-010)

Date: 2026-10-14. Final validation is in progress; the owning PLAN row remains
IN_PROGRESS until the interpreter and installed-artifact receipts are recorded.

The implementation uses CPython 3.11–3.14, public `a2a-sdk==1.2.2` protobuf hooks,
jsonschema 4.26.0 and referencing 0.37.0. It independently implements the accepted
Node inline semantics against the unchanged draft pin
`a5c007510faa3fce85190f2e76e402faf0e897ad`. No Node runtime or normative files change.

## Requirement-to-evidence map

| Responsibility / requirement | Implementation | Executable evidence |
| --- | --- | --- |
| Catalog advertiser | structurally validated extension params/catalog, unique/versioned identifiers, detached advertisement | test_catalog_payload.py; installed demo |
| Discovery | supported/unsupported capabilities, original inline descriptors/resources, skill associations, stale/unassociated visibility, ambiguity refusal | test_catalog_payload.py; test_inline_http.py; installed demo |
| Original values / portability | strict UTF-8 JSON, finite/safe numbers, explicit MISSING, no conversion/default/property removal, portable regex compilation | foundation core/validation/regex tests; test_wire_admission.py |
| Shared Node semantics | all shared validation, encoding and presence outcomes; original binding fixtures and manifest hashes | test_validation.py; test_catalog_payload.py; test_shared_binding.py |
| Client input / invocation | explicit contract/representation selection, original-value validation, primary/operation metadata, activation and admissible output negotiation | test_inline_http.py; test_binding_events.py; test_inline_peers.py |
| Server admission | raw JSON before public protobuf parsing, known methods/field shapes, zero executor calls on rejected input | test_inline_http.py; test_inline_lifecycle.py; test_wire_admission.py |
| Presence / carriers | all nine direction combinations, scalar/array/object/null JSON, empty/unicode text, optional input/output absence, completed no-output Task | test_inline_http.py; test_inline_publication.py; shared cases |
| Output publication | complete-result validation, safe initial progress, staged new-ID atomic artifacts, failed Tasks without primary output, poisoned/late queue refusal | test_binding_events.py; test_inline_publication.py; test_inline_peers.py |
| Peer validation | missing/conflicting echoes, identity/schema violations, protobuf-normalization attempts, truncated/trailing/chunked SSE, limits | test_inline_peers.py; test_shared_binding.py |
| Lifecycle | cooperative execution deadlines, request isolation, input-required binding/continuation, concurrent-turn refusal, explicit cancellation/local abort | test_inline_http.py; test_inline_lifecycle.py; test_inline_publication.py; test_inline_optional.py |
| Trusted scope | host-derived tenant captured before SDK overwrite, principal/tenant TaskStore ownership, authorization before cancellation callback | test_inline_lifecycle.py |
| Cancellation timing | gate reserved before awaiting application cleanup; cancellation cannot turn already validated publication into partial canceled output | test_inline_lifecycle.py; server publication reservation |
| Async ownership | idempotent close, per-stream response ownership, supplied HTTPX auth/hooks/default headers preserved, borrowed client left open | HTTP/lifecycle tests; installed demo |
| Distribution / DX | src layout, lightweight imports, public types/resources, rebuilt wheel from sdist, executable README and real HTTP/SSE example outside checkout | check_package.py; check_matrix.py |

The HTTP tests use real loopback sockets and the published official A2A routes,
handler, executor/event interfaces and JSON-RPC transport. Malicious peer fixtures
add focused HTTPX/SSE boundary probes. No live LLM/model credentials are needed for
these deterministic SDK tests. They do not substitute for the later independent
reference/model acceptance and four language pairings.

## Boundaries and residual work

The SDK contains no LangGraph, ADK, Microsoft agent-framework or model-provider
imports. Applications/adapters choose skills, construct business requests and
execute frameworks/models. This SDK owns advertised associations, schema views,
contract validation, metadata/negotiation and A2A plumbing. Core imports only the
standard library; protocol-independent services never depend on vendor models.

Python preserves present root null. The shared Node-carrier rejection remains an
explicit shared fixture; no wrapping/coercion is introduced. Empty repeated
protobuf Task fields may be omitted; the no-artifact outcome remains unchanged.
Failure detail uses the existing ErrorInfo metadata carrier and draft code set.

Validation runs on the calling thread with fixed structural/schema bounds.
Execution deadlines are cooperative; no hard CPU termination claim is made.
SDK-011 still owns external HTTPS graphs, DNS/connection/integrity/auth/cache
policy, process-isolated validation, operational diagnostics and benchmarks.
Push/subscriptions/list/extended-card/immediate-return/auth-required profiles,
other transports, bundles and XML are excluded. Host authentication, persistence,
retention and application resources remain host-owned. Custom stores need equivalent
owner enforcement and globally unique Task IDs.

Hosted Linux/macOS/Windows CI is configured, not assumed passed. Nothing is pushed,
tagged or published. Historical foundation/Node evidence remains unchanged.
