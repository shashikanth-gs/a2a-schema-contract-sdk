# Node release candidate validation

Status: PASS. SDK-007/008 complete for the selected Node first-release profile.

Candidate `a2a-schema-contract@0.1.0-rc.0` implements the selected Node JSON/text and explicit HTTPS profile. The [machine report](../js/reports/node-candidate-summary.json) retains exact runtime, artifact hash, coverage, installed structural/operational checks and benchmarks. The operational API, security boundaries and limitations are in [node-operations.md](node-operations.md); release/version policy is in [node-release.md](node-release.md).

Fresh Node 22.23.3 and 24.21.0 isolated copies pass `npm run check:clean`, including formatting/lint/strict types/build, all behavioral tests without skips, installed npm consumers, 20 pinned structural cases against shipped resources, worker deadline/abort cleanup, public declarations, HTTP/SSE and HTTPS examples, benchmarks and audits. The core remains at 100% coverage and every configured group/global threshold passes. No acceptance threshold was lowered.

The new semantic invariant cases use independent expected outcomes and generated range mutations. Worker tests prove event-loop responsiveness for exponential schemas, confined branch-error resource exhaustion, physical cleanup, capacity refusal and hook redaction. Source-level dispatcher invariants complement actual built-worker and installed transport execution; an in-process dispatcher test is not counted as worker isolation evidence.

Release rehearsal verifies dry-run and packed file lists, two identical SHA-256 packs and retained attribution, with publishing disabled. npm name availability was checked on 2026-10-06; an unpublished unscoped name is not owned/reserved by this rehearsal. Dependency metadata is reviewed separately from vulnerability audits; development-only MPL native tooling is not bundled in the runtime artifact.

Accepted runtime source is `7481b002f55a0961ea4ee21e36da446f2a3b9ea8`;
[the matrix](https://github.com/shashikanth-gs/a2a-schema-contract-sdk/actions/runs/37509065805)
passes Linux Node 22/24, macOS/Windows Node 24 and both compatibility jobs.
[The rehearsal](https://github.com/shashikanth-gs/a2a-schema-contract-sdk/actions/runs/37509065858)
also passes. Downloaded tarballs from every hosted OS match local SHA-256
`0f29b101df8af091fc2337cdc5eda6f0e7a234cdd18ac9330bf19d65f270c60e`;
`js/reports/hosted-sdk-node-candidate.json` retains their installed structural,
worker and benchmark evidence. Python, bundles/XML, other transports,
unrestricted schema/media/carrier behavior and package publication remain excluded.

The independent reference consumes that exact artifact at source
`0a428afdf81bfee952d351763507db598f3512b5`.
[Its accepted matrix](https://github.com/shashikanth-gs/a2a-schema-contract-reference/actions/runs/37510461774)
passes Linux Node 22/24 and macOS/Windows Node 24: 48 tests without skips,
37 inline scenarios, 43 protocol/security scenarios and documented runners.
Direct wire refusals prove zero execution; valid below-limit controls and
event/byte overflow failures, dishonest peers, output races, cancellation,
redaction and real externally advertised HTTPS catalogs provide independent
consumer evidence. The reference candidate report and machine summary retain
artifact/source pins and individual requirement mappings. Documentation/evidence
follow-up commits preserve the accepted runtime and package bytes.

The initial candidate hosted run exposed three composite-test harness deadlines:
SSE lifecycle, seven schemaless carrier round trips, and the ten-assertion external
quickstart exceeded the historical five-second Vitest test budget on Linux.
Individual validator deadline and resource tests passed. The harness now allows
15 seconds for composite integration cases and 35 seconds for the explicitly
30-second-bounded external child. Production worker budgets remain 2,000 ms and
all timeout/cleanup assertions remain enforced. The failed run is retained for
comparison; it is not acceptance evidence.

Windows also exposed a pre-aborted execution race: the abort promise could reject
before any handler was attached. The executor now checks an already-aborted signal
before creating the race and defers callback invocation until both race handlers
are installed. Regression cases cover pre-aborted signals and synchronously
throwing executors, with zero orphan rejections. This correction changes the
candidate bytes, so final SDK/reference evidence supersedes the initial hash.

The subsequent Windows run exposed two one-second test synchronization waits
while sequential client/server workers were starting. Those waits now allow five
seconds for the two individually bounded operations, and the continuation test
uses a ten-second outer transport signal. Production worker deadlines remain
2,000 ms. Pending invocations attach rejection handlers immediately so a failed
assertion cannot leave an orphan rejection during host cleanup. All 381 tests
pass in the accepted matrix, including the original cancellation assertions.
