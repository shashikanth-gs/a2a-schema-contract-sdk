# Python secure resolution and operations acceptance (SDK-011)

Completed locally: **2026-10-14**. Source
`c1d2ba34af5589413118ed428f811428c2abf6f7`, branch `codex/python-sdk`.
[Machine receipt](evidence/python-resolver/receipt.json),
[security/operational profile](python-resolver-security.md),
[architecture decisions](python-architecture.md), [public guide](../python/README.md).

SDK-011 is **DONE locally**. Four fresh locked CPython environments pass Ruff,
strict mypy, all **633 tests without skips**, **100% domain-core coverage**, installed
examples/public types, real HTTP/SSE agent execution with verified external TLS
resources, and repeatable installed-artifact benchmarks. No Node runtime or pinned
normative resource changes occurred.

| CPython / macOS arm64 | Tests | Core coverage | Overall coverage | Installed consumers |
|---|---|---|---|---|
| 3.11.15 | 633 | 100% | 93.43% | PASS |
| 3.12.13 | 633 | 100% | 93.43% | PASS |
| 3.13.14 | 633 | 100% | 93.43% | PASS |
| 3.14.7 | 633 | 100% | 93.29% | PASS |

All profiles produce the same unpublished `a2a-schema-contract==0.1.0.dev0` artifacts:

- Wheel SHA-256: `98bfa08660e814215c8e343fc67d05e91c62e96607d01854bfe9ecacce1a2f22`.
- Sdist SHA-256: `0a2ea55060ede33d4cd2607dfeda8e242744a4ca518c045eef6843b437bd0ee4`.

Each profile rebuilds an identical wheel from the sdist and installs it noneditably
outside the checkout. Normal checks need no model credentials. Audit: **92 dependencies,
zero known vulnerabilities**; the unpublished self is explicitly skipped by registry
audit and source-reviewed. Exact dependency versions, source/resource hashes, per-profile
artifact/performance reports and log hashes are retained in the receipt directory.

## Responsibility-to-evidence map

| Responsibility | Implemented behavior | Evidence |
|---|---|---|
| Resolver network policy | Canonical HTTPS; exact origins; conservative IPv4/IPv6 and zone refusal; every DNS answer checked; first approved address bound to verified original-host TLS, no fallback/second DNS/proxy | test_resolver_policy.py; test_resolver_network.py; test_resolver_tls.py |
| DNS lifetime | Default lookup uses an owned disposable process; cleanup physically reaps it on completion/deadline/cancellation | default-DNS tests; process lifecycle probes |
| Redirects/credentials | Every hop admitted; loops/downgrades refused; body discarded; cross-origin authorization dropped permanently for that chain | real TLS redirects, bounce, limit and discard tests |
| Original response bytes | h11 framing, content/media/encoding checks, bounded declared/chunked/EOF body; UTF-8/strict JSON admission before vendor normalization | real TLS framing/media/body tests |
| Integrity/cache | Canonical SHA-256/512; root/configured agreement; independent dependency pins; immutable catalog requirement; private LRU/disabled/clear; one coherent decoded snapshot across declarations | pinned/partition/limits tests; mixed-algorithm/conflicting-pin regression |
| Native schemas | Schema-position inspection; resource/base/fragment/anchor identities; private alias/regex projection; native local recursion; bounded external graph; duplicate identities/annotation refs/cross-document cycles refused | test_resolver_graph.py; existing validation/regex cases |
| Inspection for adapters | Original immutable descriptors/documents, final retrieval URI and aliases, entrypoint semantics; offline use after cache clear/resolver close | resource-view tests; installed external demo |
| Isolated async validation | Discovery compilation, client input/results, server input/final events, resolver compile jobs; fresh sterile JSON-only interpreters; no automatic retrieval | test_operations.py; unchanged HTTP/SSE/binding/lifecycle suites |
| Execution/resource budgets | 2-second worker/10-second preparation budgets; no queued excess capacity; bounded JSON/IPC; shared document pool; pre-materialization size check; result processing inside deadline | expensive-schema ticker/deadline; capacity/IPC/program-bound tests |
| Physical cleanup | Every success/failure/abort/close reaps processes; shielded handle acquisition survives repeated cancellation; stalled header/body/lookup connections close | process lifecycle/race tests; TLS stall tests |
| Diagnostics | Frozen allowlisted facts, fresh correlation UUID, duration/outcome/code; ordinary hook errors ignored; no payload/schema/URL/credential/vendor message | hook/redaction/error-context tests |
| Semantic parity | Original Node shared fixture expectations and hashes preserved; bounded-count benchmark acceptance/refusal cases match; no key-order/message-prose comparison | shared fixture tests; Node benchmark semantic tests |
| Real installed agent | Typed and skill-discovered requests through official A2A client/server, HTTP/SSE and pinned native transitive schemas; cached/offline reuse | test_external_client.py; installed inline_demo.py TLS mode |
| Distribution/maintenance | Strict public consumers, lightweight core, types/resources/attribution, reproducible wheel/sdist, docs, exact runtime/dependency profiles | check_matrix.py; check_package.py; architecture tests |

## Installed performance baseline

The workload matches Node's object with one integer `count` bounded 0..100. Counts:
10 cold catalog compile/validate samples, 10 × 1,000 warm validations, five fresh
process validations, and five cold plus five cache-warm pinned HTTPS preparations.
All cached preparations perform zero retrievals. Every worker/preparation smoke
sample passes the generous two-second benchmark ceiling. Full raw samples remain
in per-profile package receipts. The legacy receipt key `fresh_process_compile`
measures the complete fresh process compile/validate job.

| CPython | Cold compile/validate median | 1,000 warm median | Fresh process median | Cold HTTPS median | Cached HTTPS median |
|---|---|---|---|---|---|
| 3.11.15 | 0.77 ms | 10.77 ms | 54.69 ms | 110.63 ms | 108.85 ms |
| 3.12.13 | 0.79 ms | 11.04 ms | 57.65 ms | 117.62 ms | 115.57 ms |
| 3.13.14 | 0.83 ms | 11.15 ms | 60.13 ms | 121.36 ms | 119.53 ms |
| 3.14.7 | 0.84 ms | 12.83 ms | 77.31 ms | 155.56 ms | 153.11 ms |

Cached preparations still compile in fresh workers; they save retrieval, not all
work. Investigate more than 3× a same-host/interpreter/workload baseline. These
samples are not a throughput promise or a comparison across unlike Node/Python hosts.

## Review corrections and actual platform limits

The accepted source includes review fixes for URI identity normalization, scoped
IPv6 DNS results, caller error context, coherent mixed-pin snapshots and shared-resource
program amplification. Resource pooling avoids duplicating a large schema once per
representation. Size checks run before materializing documents. Result parsing is
inside the validation budget and explicitly checks elapsed time when a timer callback
could not run during bounded synchronous processing.

macOS rejects data-limit setters in the probe; CPython 3.14/macOS also rejects stack
setters even for a round trip. The worker preserves its already stricter inherited
soft stack limit instead of attempting to raise/change it. Required lowering that
the host refuses fails closed. POSIX soft-stack and Linux soft-data controls are
distinct from hard wall-time/data/schema limits and **do not establish a portable
hard RSS ceiling**. Windows has no `resource` module. Strict resident-memory deployment
policy remains host-owned; details are explicit in the security profile.

Synchronous prepare/select/validation/output helpers remain trusted calling-thread
APIs without a hard deadline. Async boundaries independently recheck before execution
or publication. Business CPU/model/tool work, authentication and custom persistence
remain application-owned. Cancellation propagates after owned cleanup; OS cleanup
latency may extend observed return time beyond a work deadline. Custom DNS callbacks
are trusted/cooperative; the default has physical process ownership.

The supported semantic profile remains bounded JSON Schema 2020-12 JSON/text; bundles,
XML, nonlocal dynamic refs, cross-document cycles, other A2A transports/profiles and
unrestricted schema assertions are excluded. Python preserves root null; the accepted
Node carrier still rejects it. No framework/model dependency enters the SDK core.

## Reproduction and remaining gates

From `python/`:

```sh
rtk proxy .venv/bin/python scripts/check_matrix.py
rtk proxy .venv/bin/pip-audit --format json --output reports/sdk011-audit.json
```

The matrix creates fresh locked environments, retains command outputs, and runs
noneditable installed consumers. Package checks copy TLS fixtures/demo/benchmark
outside the checkout; tests do not substitute sibling source/schema imports for
installed acceptance. The known test-only certificate/key is never a production
trust identity. Historical failed/intermediate local attempts are superseded by
the final identical artifacts and receipt, not presented as acceptance.

Hosted Linux/macOS/Windows workflow is configured but **unrun for this Python source**.
Four JS/Python client/server pairings and independent reference applications remain
**REF-005/006**. Python release metadata/name ownership, hosted acceptance and the
release-candidate gate remain **SDK-012**. M4 stays IN_PROGRESS. No push, tag, PyPI
publication or live-model claim is made by this milestone.
