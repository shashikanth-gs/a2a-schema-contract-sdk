# SDK-006 secure Node external resolution completion

Completed locally on 2026-10-06 by Codex on
`codex/sdk-006-secure-resolution`. Validation used the local working tree;
the validated local source checkpoint is
[`87c96e7`](https://github.com/shashikanth-gs/a2a-schema-contract-sdk/commit/87c96e756fa8e9b0e5e0caa6b51498260df8f036). No remote, PR, push, tag or package
publication occurred. Normative inputs/vendor files were not modified.

The public `/resolver` provides explicit HTTPS preparation of inline/external
catalogs and JSON Schema 2020-12 document graphs. Client discovery opts in via
`resolver`; server creation accepts the prepared catalog. All subsequent
selection/input/output validation is offline. Root descriptors and native
resources remain intact; no coercion or schema inlining changes their meaning.

| Acceptance criterion | Implementation and evidence |
|---|---|
| External catalogs/schemas, fragments/bases/native/transitive resources; immutable catalog; no validator fetch | `src/resolver/{index,registry}.ts`, offline shared Ajv configuration; catalog pin/immutability, pointer/anchor/nested-ID/DAG/local recursion/annotation-target tests; public demo |
| HTTPS, no URL credentials, DNS/IP per redirect, bind approved connection; internal-target default refusal | `policy.ts`, `network.ts`; direct approved IP with original TLS/Host; numeric/encoded host cases, mixed/changed DNS answers, literal IP, SAN/trust refusal, environment override tests |
| Redirect/byte/time/graph/nesting/cache limits and cycles | `RESOLVER_LIMITS`, existing core snapshots/profile, LRU byte cache; length/chunk/total/graph/depth/nesting/concurrency/redirect/cycle/deadline/abort tests |
| SHA-256/SHA-512 before parsing; content encoding/cache identity/poisoned resources | Canonical base64 pin + timing-safe digest comparison of identity-encoded final body; independent child pins, poisoned invalid JSON, changed pin, immutable/mutable cache tests |
| Private credentials/cache identities and safe redirects | Per-instance copied configuration/cache; exact-origin Authorization only; permanent removal after cross-origin hop; no cookies/pools/shared cache; origin-bounce/two-identity/snapshot tests |
| Controlled deterministic fixtures including exhaustion/rebinding/cancellation | Local real HTTPS fixture with public test certificate/key; exact localhost administrator exception and controlled DNS; no arbitrary public catalog/schema hosts |
| Public types/configuration/errors and shipped artifact | [Node guide](../js/README.md), [threat model](resolver-security.md), ADR-010, strict no-peer resolver declarations, isolated tarball consumers and HTTPS/A2A quickstart |

From `js/`, final fresh validation commands:

```sh
npm exec --yes --package=node@22.23.3 -- npm run check:clean
npm exec --yes --package=node@24.21.0 -- npm run check:clean
npm audit --json
```

Each clean command copies only source/pinned resources into a new temporary
directory, installs the lock, builds, checks formatting/lint/strict types, runs
**359 tests with no skips**, and runs **21 isolated installed-consumer checks**.
This includes the existing 248-test checkpoint and 111 added cases: 109 resolver
cases plus prepared source integration and the built external public-API demo.
The original 20 structural checks and shared semantic vectors still pass in
the existing core suite. The artifact contains all seven normative schemas,
types, license/attribution and the resolver export, with no test keys or development
dependencies in the package. Resolver imports/declarations work without the
optional official peer; HTTP/SSE integration uses exactly `@a2a-js/sdk@1.3.0`.

The installed external demo has ten assertions: catalog/root/transitive pins,
prepared server plus discovered client, HTTP roundtrip, invalid input with zero
execution, invalid output with no successful Artifact, SSE result, no invocation-time
retrieval, independent client refusal of a malicious peer and opt-in refusal.
It makes five controlled HTTPS retrievals across separate server/client identities
and four business executions for admitted requests. The six original inline
HTTP/SSE quickstart assertions also pass. Installed strict core, resolver,
client/server and adapter declarations all compile.

Both final `0.1.0-dev.0` tarballs have SHA-256:

```text
d7c6886a7b672d17918f4b25f1896a412c2b9e132cd33581b41d56ebfd6f325d
```

They are retained locally under `js/artifacts/resolver-node{22,24}/`. Development
and isolated installed runtime audits report **zero findings**. No new dependency
was added. All 33 pinned source hashes remain verified.

Aggregate coverage is 94.00% statements / 92.39% branches / 96.57% functions /
97.28% lines. Core retains 100% in all four metrics. Resolver coverage is 97.79%
statements / 96.20% branches / 100% functions / 98.43% lines, against added resolver
thresholds 95/90/100/95. Existing thresholds were preserved. These are macOS arm64
Node 22.23.3/24.21.0 results; hosted Linux/macOS/Windows CI is configured but unrun.

Machine evidence:

- [Summary](../js/reports/resolver-summary.json) and [development audit](../js/reports/resolver-audit.json).
- [Node 22 clean](../js/reports/resolver-clean-node22.json), [complete log](../js/reports/resolver-clean-node22.log), [installed consumer](../js/reports/resolver-package-node22.json).
- [Node 24 clean](../js/reports/resolver-clean-node24.json), [complete log](../js/reports/resolver-clean-node24.log), [installed consumer](../js/reports/resolver-package-node24.json).

The [support matrix](support-matrix.md), [requirements](requirements.md) and
[security model](resolver-security.md) record explicit limitations: no bundles,
XML/XSD, Python, other dialects or non-fragment dynamicRef; percent-encoded leading
pointer slash refused; local recursion permitted while cross-document retrieval
cycles are refused. System DNS may continue after caller cancellation but cannot
open a late socket. Synchronous compiler/validator worker isolation, benchmarks,
diagnostic hooks, hosted execution and independent reference security scenarios
remain SDK-007 and REF-003. SDK-006 does not close M3 or claim full-draft conformance.
