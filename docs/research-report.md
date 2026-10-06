# SDK-001 published-artifact research report

Completed 2026-10-06. Local working-tree evidence; no commit/PR created. Contract revision `a5c007510faa3fce85190f2e76e402faf0e897ad`. SDK revision, npm integrity and resolved dependency hashes are recorded in [architecture](architecture.md), the research lockfile and the source manifest. No inputs were edited.

## Reproduce

From `research/a2a-js-1.3.0/`:

```sh
npm ci
npm run typecheck
npm exec --yes --package=node@22.23.3 -- node probe.mjs
npm exec --yes --package=node@24.21.0 -- node probe.mjs
node structural.mjs
npm audit
```

30 public-codec/real-HTTP probes pass on Node **22.23.3** and **24.21.0**, macOS/arm64; Node 26.5.0 also passes as incidental host evidence. `report-node22.json`, `report-node24.json`, `report-node26.json` record runtime, lock hash and each assertion/finding. Strict TypeScript 5.9.3 public-hook probe compiles with library checking enabled. All **20** upstream structural cases pass using fresh Ajv 8.20.0 / ajv-formats 3.0.1 and **33** verified source hashes (`structural-report.json`). Fresh research dependency audit: zero vulnerabilities (`audit.json`). npm installed the published package whose SHA-512 integrity matches the registry and lock; no main-branch implementation imports.

## Hook and ownership matrix

| Concern | Released public API | Observation / required implementation |
|---|---|---|
| Discovery | `ClientFactory.createFromUrl`, `getAgentCard`, `AgentCard` | Params survive; select only JSONRPC/1.0 transport; never legacy fallback |
| Per-call behavior | `CallInterceptor`, `RequestOptions`, `ServiceParameters`, `withA2AExtensions` | Type checked; preserve auth/fetch/service params/context and signal; no implicit retries |
| Activation | `ServerCallContext.requestedExtensions`, `addActivatedExtension` | Header parsed per request; explicit activation acknowledgment; unknown requests filtered to advertised URIs |
| Required extension | `DefaultRequestHandler` | Missing activation produces -32008 before executor |
| Request boundary | `A2ARequestHandler`, `RequestContext.request` | Decorate handler before default SDK history mutation, then validate before business executor |
| Raw carrier boundary | Public HTTP middleware / exported guard before `jsonRpcHandler` | Necessary because codecs stringify invalid text and prefer first content member |
| Output boundary | `AgentExecutor`, `ExecutionEventBus`, `AgentEvent.*` | Synchronous publication; validate/stage before forwarding, retain initial Task/Message ordering |
| Lifecycle/store | `TaskStore`, `InMemoryTaskStore`, `ResultManager`, bus manager | Completed no-artifact Task retains result metadata; reuse SDK ownership; continuation/cancel guarantees pending SDK-005 |
| Streaming | `sendMessageStream`, `StreamResponse.payload`, Task/status events | Real SSE first Task then final status metadata works; no atomic-validation guarantee supplied by SDK |
| Error binding | `ContentTypeNotSupportedError`, `RequestMalformedError`, `ErrorInfo.metadata` | Existing content code -32005; draft detail in URI-namespaced JSON string, not invented protobuf @type |
| Executor exception | Default handler catches/rebuilds failed Task | Original text disclosed and console logged; adapter must catch/sanitize/publish itself |

Root `data:null` is encoded but decoded as absent by the **public** Part codec and the **actual HTTP** handler. Nested null, objects, empty objects/arrays, scalars/zero/false, empty JSON string and empty text survive. Media parameters and namespaced metadata retain exact text. This is a supported restriction; no wrapper/coercion workaround is allowed. The probe's PASS for this bug means the known limitation was reproduced, not that null works.

## Extension precedents

Pinned revisions and content SHA-256 checks are in `research/a2a-js-1.3.0/sources.json`; `sources.mjs` refreshes evidence from those exact revisions (not moving main). This comparison is research only; no foreign code is copied into runtime.

| Source | Reusable pattern | Difference / does not prove |
|---|---|---|
| [Released timestamp sample](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/samples/extensions/README.md) | Wrap executor/event bus, advertise extension, activate per HTTP request | Adds timestamps to status messages; no payload schema/presence/security validation or invalid-output guard |
| [A2UI](https://github.com/a2ui-project/a2ui/blob/46ecc2d04793c0b8b1c77f8acd9d7ab4e34746c2/README.md) | Declarative data plus trusted local component catalogs; separate generation, transport and rendering | v0.9.1 stable family / v1.0 candidate described at this revision; incremental UI protocol is not Draft 0.1 atomic primary semantics; does not prove arbitrary schema boundaries |
| [Traceability](https://github.com/a2aproject/a2a-samples/blob/6603ba3f2c31a7ef33e70b9d8b5b5f8be42ac9a3/extensions/traceability/v1/spec.md) | URI namespacing, Message/Artifact metadata and activation | Uses legacy X-A2A-Extensions and protobuf Struct examples; do not transplant header or scalar limitations to 1.0; trace recording is not input/output validation |
| [A202](https://github.com/a202-protocol/a202/blob/8473b0421fdc2a0d9e4bcd299cf9937ee68bf556/reference/README.md) | Explicit role-scoped conformance, pure validation, fail-closed declaration handling | Local Python schema/evidence/signature functions; no network client/server; commercial semantics and refusal code do not apply to Schema Contract |

## Clarifications retained for upstream

These notes are local and have not been posted upstream. SDK work can proceed using the explicit restrictions/placement policy; the source draft stays immutable.

1. Official JS Part null codec: use member presence rather than a non-null test for JSON Value; repro is `codec-root-null-loss` / `http-root-null-loss`.
2. Invocation scope: draft requires namespaced metadata but not Message versus SendMessageRequest placement. Recommend operation metadata and an explicit binding rule; current Message-fragment example differs. Choose operation metadata locally and reject conflicting duplication.
3. Result/error scope: recommend Task/standalone Message result echo and final status-event echo, plus guidance for ErrorInfo string-map detail versus typed Any. Use existing namespaced facilities locally (ADR-005).
4. Format assertions: clarify that the sample `email` error demonstrates the detail shape, not required email assertion under standard 2020-12 annotation semantics.
5. Resolver cycles: distinguish unsupported retrieval cycles from legal native recursive schemas, and define integrity of compressed representations/transitive resources. Local candidate requires identity encoding and independently pinned dependencies.

Published sources: [A2A 1.0 specification](https://a2a-protocol.org/v1.0.0/specification/), [JSON Schema 2020-12 validation](https://json-schema.org/draft/2020-12/json-schema-validation), [Ajv options](https://ajv.js.org/options.html). Decisions that constrain accepted schemas/carriers are in the support matrix and requirement map. No library, extension conformance, Linux/Windows, Python or release-readiness claim follows from SDK-001 alone.
