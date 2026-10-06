# Node release candidate validation

Status: local SDK gates pass; candidate hosted CI and final independent reference acceptance are pending. SDK-007/008 remain open until all acceptance evidence is recorded.

Candidate `a2a-schema-contract@0.1.0-rc.0` implements the selected Node JSON/text and explicit HTTPS profile. The [machine report](../js/reports/node-candidate-summary.json) retains exact runtime, artifact hash, coverage, installed structural/operational checks and benchmarks. The operational API, security boundaries and limitations are in [node-operations.md](node-operations.md); release/version policy is in [node-release.md](node-release.md).

Fresh Node 22.23.3 and 24.21.0 isolated copies pass `npm run check:clean`, including formatting/lint/strict types/build, all behavioral tests without skips, installed npm consumers, 20 pinned structural cases against shipped resources, worker deadline/abort cleanup, public declarations, HTTP/SSE and HTTPS examples, benchmarks and audits. The core remains at 100% coverage and every configured group/global threshold passes. No acceptance threshold was lowered.

The new semantic invariant cases use independent expected outcomes and generated range mutations. Worker tests prove event-loop responsiveness for exponential schemas, confined branch-error resource exhaustion, physical cleanup, capacity refusal and hook redaction. Source-level dispatcher invariants complement actual built-worker and installed transport execution; an in-process dispatcher test is not counted as worker isolation evidence.

Release rehearsal verifies dry-run and packed file lists, two identical SHA-256 packs and retained attribution, with publishing disabled. npm name availability was checked on 2026-10-06; an unpublished unscoped name is not owned/reserved by this rehearsal. Dependency metadata is reviewed separately from vulnerability audits; development-only MPL native tooling is not bundled in the runtime artifact.

Source checkpoints, hosted run links and independent reference pins will be added after their actual gates pass. Python, bundles/XML, other transports, unrestricted schema/media/carrier behavior and package publication remain excluded.


The initial candidate hosted run exposed three composite-test harness deadlines:
SSE lifecycle, seven schemaless carrier round trips, and the ten-assertion external
quickstart exceeded the historical five-second Vitest test budget on Linux.
Individual validator deadline and resource tests passed. The harness now allows
15 seconds for composite integration cases and 35 seconds for the explicitly
30-second-bounded external child. Production worker budgets remain 2,000 ms and
all timeout/cleanup assertions remain enforced. The failed run is retained for
comparison; it is not acceptance evidence.
