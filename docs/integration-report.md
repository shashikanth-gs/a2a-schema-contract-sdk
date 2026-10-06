# SDK-004/005 inline HTTP integration evidence

The combined batch delivers public official-SDK client/server adapters and the
bounded inline presence, negotiation and lifecycle profile. Completed locally
2026-10-06 by Codex; no commit, PR, hosted CI or publication. The pinned normative
source and existing SDK-003 core are unchanged.

## Implemented boundaries

- `js/src/server/index.ts`: validated advertising; request-handler validation
  before continuation-history writes; request-scoped activation; existing
  TaskStore and authenticated/application context; event staging and sanitized
  executor failure; persisted continuation association and concurrent-turn gates.
- `js/src/adapters/a2a-js/boundary.ts`: pre-codec request/Part/container guards,
  exact negotiation, published ErrorInfo mapping and complete result validation.
- `js/src/client/index.ts`: URL/configured-client discovery, schema exposure,
  local encoding/presence checks, activation preserving existing extensions and
  options, independent chosen-representation validation, bounded async streaming
  and pre-codec JSON/SSE response guards.
- `js/examples/http.mjs` and `http-types.ts`: runnable public JS application and
  strict TS declarations, installed outside the source checkout.

## Acceptance and requirement evidence

All cases below are in `js/test/integration.test.ts`; complete installed artifact
checks are in `js/scripts/package-smoke.mjs` and use public imports only.

| Task criterion / requirement IDs | Evidence |
|---|---|
| SDK-004 advertising/hooks; D04-01/04 | Discovered card contains pinned URI/catalog/schema; public DefaultRequestHandler/executor/event interfaces; advertising copies application card; explicit contract lookup |
| SDK-004 activation; D04-03, D07-01 | Required activation -32008 before execution; optional baseline and concurrent activation/context isolation; contract metadata without activation refused |
| SDK-004 input timing; D06-01, D07-02/03, D09-01/02 | Local validation prevents dispatch; raw malformed/coerced/multiple/null/invalid-schema inputs cause zero business calls and no Task history; refused continuations preserve history |
| SDK-004 output timing; D10-01/02/03 | Invalid output, wrong identity/echo, empty Artifact/ID, duplicate primary, append, overflow, no event and executor throw after candidate success become FAILED with no contracted output |
| SDK-004 discovery/client; D05-04, D10-04 | Public schema exposure; actual HTTP peer rejects invalid schema, missing/wrong echo, missing/multiple primary, wrong role and raw coercion/root null; alternative admissible peer choice accepted independently |
| SDK-004 application ownership; D09-04, D13-06 | Auth/application headers and existing extension requests preserved without mutating caller options; caller abort, application disconnect signal, deadline and explicit CancelTask tests; no added retry |
| SDK-004 installed path | Fresh tarball executes discovery, HTTP round trip, local zero-dispatch, direct wire zero-execution, failed-output/no-Artifact and SSE; strict public client/server TS example compiles |
| SDK-005 presence/media; D05-02/03/04, D06-02/03, D11-01 | All nine direction combinations plus both present/omitted optional alternatives over HTTP; JSON/text cross directions, empty text, scalar/array/empty/nested-null schemaless data, root-null refusal; valid companion trigger/no-output Task |
| SDK-005 negotiation; D07-04/05/06, D10-04 | Accepted IDs/media intersection, case/quoted charset, unsupported IDs/disjoint media, namespace scopes and result echoes; client validates peer selection against both mechanisms |
| SDK-005 continuation; D07-01/03, D10-04 | INPUT_REQUIRED Task retains association in official storage, resumes same Task, rejects changed negotiation/baseline activation/terminal reuse before history writes |
| SDK-005 artifacts/events; D06-01/03, D12-01 | Multiple companion artifacts and same-media companion Parts ignored by primary selection; atomic SSE aggregate; conflicting identities/echoes, duplicate primary, append/empty/duplicate-ID and unfinished event sequences fail closed |
| SDK-005 streaming/cleanup; D12-01, D14-01/02 | Async companion/result stream; Message, Task, omission, interruption, post-success failure, cancellation and deadline; raw SSE byte/end-frame checks and upstream reader cancellation; 128-event/256-KiB staging |

Core schema/media/identity/presence semantics retain the prior 100% core coverage
and shared fixture expectations. Integration coverage floors are documented in
`js/README.md` and `vitest.config.ts`; they supplement behavioral guarantees.

## Reproduction

From `js/`:

```sh
npm exec --yes --package=node@22.23.3 -- npm run check:clean
npm exec --yes --package=node@24.21.0 -- npm run check:clean
```

Each command creates an independent temporary source copy, performs fresh `npm ci`,
format/lint/strict types/hash-verified build, behavioral coverage and an isolated
installed tarball check. It requires npm registry access for installation; normal
inline contract execution is offline and never needs workspace inputs or remote
schemas. Exact runtime/artifact/coverage evidence is retained in
`js/reports/integration-clean-node{22,24}.json`, corresponding package reports/logs,
`integration-summary.json` and `js/artifacts/integration-node{22,24}/`.

## Final results

Both Node **22.23.3** and **24.21.0** pass fresh installation and the complete gate
on macOS arm64: **248 Vitest tests** (56 transport/binding cases plus 192 existing
core/foundation cases), 17 installed-consumer checks and six real HTTP/SSE
quickstart assertions per runtime. Prior structural/shared fixture checks remain
included. No tests or coverage gates are skipped.

Aggregate coverage is 92.52% statements, 90.88% branches, 95.41% functions and
96.81% lines; the required core group remains 100% in all four dimensions.
Development and installed-runtime audits have zero findings. Exact peer min/max
are both 1.3.0. Both 0.1.0-dev.0 tarballs have SHA-256
`3476778550e9b570bb60d7529faa6c7a63c4fee9d67f0911e879809cdd8f1bd4`. Each clean report records commands and exact platform;
package reports include file inventory, source revision, consumer lock hash,
public-import/type checks and transport assertion names.

## Accepted profile and residual work

ADR-009 and `js/README.md` define the event grammar and ownership in detail. Safe
initial WORKING Tasks may publish immediately; other events stage until execution
settles. Synchronous bus overflow fails closed instead of inventing an awaitable
publish contract. Atomic new-ID non-append artifact updates are supported; append,
replacement/record streams, AUTH_REQUIRED resumption and return-immediately are
refused. INPUT_REQUIRED resumes through the existing TaskStore and a fresh bus.
Business I/O must cooperate with the abort signal; arbitrary business work and
synchronous validation cannot be forcibly stopped by an async timeout.

External catalogs/schema retrieval remain disabled pending SDK-006. Synchronous
worker isolation, hostile benchmarks, broader operational/authorization checks
and hosted OS CI are SDK-007 gates. Reference harness/scenario completion remains
REF-001/002; SDK package smoke evidence is not claimed as independent reference
completion. Python/parity, publication/name ownership, bundles and XML remain
future tasks. Root M2 cannot become DONE until the reference tasks pass.
