# Support target and actual evidence

As of 2026-10-06, SDK-003–006 implement the offline core and official 1.3.0
inline JSON-RPC/HTTP client/server profile. See the [integration report](integration-report.md)
and [Node API/lifecycle guide](../js/README.md). Independent reference tasks,
synchronous worker isolation, Python and hosted portability
remain separate delivery gates.

| Feature | Inline target | Current evidence / limitation | Delivery task |
|---|---|---|---|
| Runtime | Node 22 >=22.23.3 / 24 >=24.21.0; ESM | 30 compatibility probes plus clean package gates on macOS arm64; [hosted baseline](https://github.com/shashikanth-gs/a2a-schema-contract-sdk/actions/runs/37497396103) passes Linux Node 22.23.3/24.21.0 and macOS/Windows Node 24.21.0 at `6d51d99`; worker/operational gates remain SDK-007 | SDK-002/007 |
| Official SDK | @a2a-js/sdk exactly 1.3.0 | Published integrity/revision in architecture and probe lock | SDK-001/004 |
| A2A transport | 1.0 JSON-RPC/HTTP + SSE | Real adapter HTTP/SSE tests and isolated tarball quickstart: discovery, both result shapes, activation, storage and independent peer rejection | SDK-004/005 |
| Other transports / SDK versions | Unsupported | Reject rather than fallback | SDK-004 |
| Contract structures | Pinned seven extension schemas; uniqueness/immutable IDs | Pinned structures, unique/versioned IDs, params and capability diagnostics exercised by core tests | SDK-003 |
| Inline JSON Schema | 2020-12 object/Boolean, standard vocabularies | Inline schema/instance validation, native local/recursive/dynamic refs tested; fixed preflight budgets; Ajv-ignored `__proto__` schema-map entries refused explicitly; worker/performance evidence pending SDK-007 | SDK-003/007 |
| Format / content | Annotation only | Annotations tested; required assertion, custom dialect/vocabulary and unknown assertion keywords explicitly rejected | SDK-003 |
| Regex / numbers | Bounded ASCII regex profile; finite binary64/safe integers; integer multipleOf | ASCII grammar with at most one variable quantifier, finite/safe-number guards tested; Python parity pending | SDK-003/010 |
| JSON data values | Objects, arrays, scalars, nested null | Core and HTTP JSON object/scalar/array/empty/nested-null round trips pass | SDK-003/004 |
| Root JSON null | Core value; **unsupported official adapter** | Core preserves null; raw input/output guards and official encode/decode profile reject root null before codec loss | SDK-003/004 |
| Text | text/plain, absent/UTF-8 charset, empty text valid | HTTP text-to-JSON, JSON-to-text, empty text and quoted/case-insensitive UTF-8 negotiation pass | SDK-003/005 |
| Other media / binary / raw / URL | Unsupported | Core refuses unsupported primary media/carriers; raw/URL companions shape-checked only | SDK-003 |
| Presence required/optional/none | All directions within carrier restrictions | All nine direction combinations over HTTP; no-input companion, optional omission and completed no-output Task pass | SDK-005 |
| Primary / invocation / result | URI namespace; operation invocation, Task/Message result | Operation invocation, Task/Message/final status echo, identity/cardinality and conflicting placements enforced over HTTP/SSE | SDK-003/004 |
| Negotiation | IDs ∩ exact media modes; selected once per task | Both accepted-ID and exact-media restrictions enforced; client accepts any admissible peer choice; server retains selection on continuation | SDK-005 |
| Streaming / continuation / cancellation | Companion streaming, bounded atomic primary, explicit cancellation | Safe initial WORKING Task may stream; remaining events staged (128 / 256 KiB) until complete validation; atomic new-ID non-append updates only; INPUT_REQUIRED continuation, explicit cancel, abort/deadline tested; AUTH_REQUIRED/immediate-return excluded | SDK-005/007 |
| Errors | Existing A2A errors + sanitized draft details | Existing -32602/-32005/-32008 errors with scoped ErrorInfo; sanitized failed Task/OUTPUT_CONTRACT_VIOLATION and no contracted Artifact; explicit CANCELED state | SDK-004/007 |
| External catalog/schema/resources | Explicit HTTPS resolver; offline preparation/validation | Pins/immutable catalogs, connection-bound DNS/IP policy, redirects/auth/cache isolation, fragment/base/native resources, bounded graph and I/O cancellation; deterministic HTTPS fixtures and installed HTTP/SSE demo on Node 22/24. Local recursion supported; cross-document cycles, nonlocal dynamicRef, encoded leading pointer slash refused; worker isolation/hosted operational gates remain | SDK-006/007 |
| Bundles / XML/XSD | Deferred, unsupported | No conformance claim | SDK-014/015 |
| Python / four pairings | Planned after Node candidate | No implementation or parity claim | SDK-009–012 / REF-006 |

The adapter must reject unsupported features using local diagnostics plus valid existing binding/draft codes when appropriate. Removing the root-null limitation requires a reviewed upstream fix and re-probing; it does not permit transformation of a caller value. See [architecture](architecture.md) for policies and [requirements](requirements.md) for pending behavioral evidence.

The exact core budgets, regex grammar, ID syntax, carrier profile and public synchronous API are documented in [js/README.md](../js/README.md) and ADR-008. Worker deadlines, performance isolation and full authenticated/security conformance are not core completion claims. Secure retrieval is explicit opt-in; see [resolver evidence](resolver-report.md) and [threat model](resolver-security.md). Header/context pass-through and bounded streaming are integration evidence.
