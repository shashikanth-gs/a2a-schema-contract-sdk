# SDK implementation plan

Updated: 2026-10-06  
Status: Node candidate validation in progress; SDK-007 operational implementation and local gates pass

Next gate: hosted SDK-007 validation and independent REF-003/004 evidence; then SDK-008 acceptance
Companion tracking: [reference roadmap](https://github.com/shashikanth-gs/a2a-schema-contract-reference/blob/main/PLAN.md). Workspace milestone tracking is maintained internally.

This repository builds reusable JS/TypeScript and Python client/server packages. The reference repository installs the resulting artifacts and proves real usage. The specification repository owns the normative contract; its initial revision is pinned in [contract-source.json](contract-source.json).

## Task index

Each row is the authoritative status for that task. Dependency references to REF-* are owned by the reference repository. Evidence below is required before changing a row to DONE.

| ID | Deliverable | Status | Owner | Dependencies |
|---|---|---|---|---|
| SDK-001 | Research, compatibility probes and architecture decisions | DONE | Codex | Preparation complete |
| SDK-002 | Node engineering and package foundation | DONE | Codex | SDK-001 |
| SDK-003 | Complete JS inline contract/validation core | DONE | Codex | SDK-002 |
| SDK-004 | JS A2A client/server integration | DONE | Codex | SDK-003 |
| SDK-005 | Complete Node presence, negotiation and lifecycle profile | DONE | Codex | SDK-004 |
| SDK-006 | Secure Node external catalog/schema resolution | DONE | Codex | SDK-005 |
| SDK-007 | Node conformance, security and operational validation | IN_PROGRESS | Codex | SDK-006 |
| SDK-008 | Node developer documentation and release candidate | IN_PROGRESS | Codex | SDK-007, REF-004 |
| SDK-009 | Python engineering and package foundation | PLANNED | Unassigned | SDK-008 |
| SDK-010 | Independent Python inline client/server profile | PLANNED | Unassigned | SDK-009 |
| SDK-011 | Python secure resolution and operational parity | PLANNED | Unassigned | SDK-010, SDK-006, SDK-007 |
| SDK-012 | Python developer documentation and release candidate | PLANNED | Unassigned | SDK-011, REF-006 |
| SDK-013 | Joint release rehearsal and maintenance readiness | PLANNED | Unassigned | SDK-008, SDK-012, REF-008 |
| SDK-014 | Safe schema-bundle support in both languages | DEFERRED | Unassigned | SDK-013 |
| SDK-015 | Explicit XML/XSD validation support in both languages | DEFERRED | Unassigned | SDK-014 |

## Working rules and completion standard

A task includes implementation, negative-path behavior, relevant tests, public API/configuration documentation and shipped-artifact verification. It is not complete when only the happy path works. Track ambiguities and residual limitations; do not silently weaken the contract.

Statuses: READY, PLANNED, IN_PROGRESS, BLOCKED, DONE, DEFERRED. On start, replace Unassigned and record the start date in the evidence block. On completion, record commit/PR, commands/results, report and documentation paths, artifact version/hash where applicable, and tested runtime/SDK versions. A blocker needs an actual reason and resolution needed. Scope changes update both the support matrix and workspace gates.

Use a requirement-to-evidence map for the advertiser, client, server and resolver roles. Ship normative resources from a verified pinned source with attribution. Installed core functionality must not require the workspace's `inputs/` directory or network access.

Initial supported transport is A2A 1.0 JSON-RPC over HTTP. Unsupported schema dialects, delivery forms, carriers and transports must be visible and rejected consistently. Do not add protocol fields, draft error codes or URI versions merely to make an adapter work.

## SDK-001: Research, compatibility probes and architecture decisions

Outcome: a defensible design grounded in published packages and the pinned draft, ready to implement.

Acceptance criteria:

- Review draft sections 4–16, all seven extension schemas, examples and conformance cases. Map every applicable normative requirement to a role, planned implementation task and intended test/evidence.
- Inspect released Node SDK code/artifacts, client discovery/interceptors, activation, request context, executor/event publication, errors and task storage. Start with v1.3.0 as a candidate; record actual version, source revision and probes rather than relying on main-branch documentation.
- Probe Part support for JSON objects/scalars/arrays/null, text/media parameters, metadata carriers, completed Tasks without Artifacts, and Message versus Task responses. Identify wire/protobuf JSON translation limits.
- Compare A2UI, the released JS extension sample, Traceability and A202. Record reusable patterns, version differences and what each example does not prove. Retain source URLs, revisions and research findings.
- Record ADRs for public API boundaries, transport support, schema vocabularies/format behavior, regex portability, JSON numeric precision, error mapping, immutable sources, resolver policy, ESM/CJS support and package dependency strategy.
- Close blocking ambiguities with a documented supported restriction or upstream proposal. Produce an explicit support matrix and acceptance matrix; unsupported features cannot be mistaken for implemented support.

Evidence: Started/completed 2026-10-06, owner Codex; local working tree, no commit/PR. [Research report](docs/research-report.md), [ADRs](docs/architecture.md), [support matrix](docs/support-matrix.md), [requirements and acceptance map](docs/requirements.md). Published `@a2a-js/sdk@1.3.0` / gitHead `29417a5bb4038f804f310ce4fffd267a9375aa90`, integrity pinned in `research/a2a-js-1.3.0/package-lock.json`. Commands from that directory: `npm ci`, `npm run typecheck`, `npm exec --yes --package=node@22.23.3 -- node probe.mjs`, `npm exec --yes --package=node@24.21.0 -- node probe.mjs`, `node structural.mjs`, `npm audit`. 30 compatibility assertions pass per supported Node version on macOS arm64; 20 structural cases and 33 source hashes pass; zero audited vulnerabilities. Reports: `report-node22.json`, `report-node24.json`, `structural-report.json`, `audit.json`, `sources.json` under the research directory. Actual extension implementation remains pending. Root JSON null is unsupported by the official adapter; raw-wire coercion guards and sanitized executor failures are required. These restrictions narrow M2, documented in the root decision log.

## SDK-002: Node engineering and package foundation

Outcome: a reproducible, typed and testable npm package foundation with validated installation.

Acceptance criteria:

- Configure strict TypeScript, source/declaration output and public module boundaries for core, client, server and official SDK adapters. Declare engine/module/export policy from SDK-001; no accidental browser or CJS compatibility promises.
- Set up one formatter, linter and test runner, strict type checks and a documented aggregate check command. Configure deterministic tests, coverage reporting and timeouts; define meaningful thresholds for contract-critical paths.
- Resolve current reviewed dependencies with a development lockfile. Set runtime/peer/dev classifications correctly and test peer compatibility boundaries. Do not reuse the affected source-input lockfile.
- Configure package files/exports/types, README/license inclusion and build-time resource sourcing from a pinned specification revision. Preserve attribution for copied/generated resources.
- Build and install an npm tarball in an isolated consumer; test documented public imports and declarations, including a plain JavaScript consumer. No use of internal source paths.
- Add initial CI for clean install, formatting, lint, types, tests, build and artifact smoke tests on supported Node LTS versions. Document local setup and contribution commands. No fake passing test scripts or placeholder release workflow.

Evidence: Started/completed 2026-10-06, owner Codex; local working tree, no commit/PR. [Foundation report](docs/foundation-report.md), [Node setup/public exports](js/README.md), [contribution guide](CONTRIBUTING.md), `.github/workflows/node.yml`. From `js/`: `npm exec --yes --package=node@22.23.3 -- npm run check:clean` and `npm exec --yes --package=node@24.21.0 -- npm run check:clean` pass fresh `npm ci` + formatting/lint/strict types/build + five Vitest tests at 100% foundation coverage + ten isolated installed-artifact checks. macOS arm64 evidence in `js/reports/clean-node{22,24}.json` and `package-node{22,24}.json`; peer min/max both exact 1.3.0. Artifact 0.1.0-dev.0 SHA-256 `e8d328aa34b3ad555648f7933b060403650c3a8118e42af946506cdbd6144668`; seven original schemas/attribution shipped from 33 verified source hashes. Fresh audits report zero vulnerabilities; license/dependency reports retained. Hosted CI/other OS execution, scope ownership and runtime extension behavior remain downstream work; package private, no publication.

## SDK-003: Complete JS inline contract/validation core

Outcome: a framework-independent core that correctly selects and validates inline JSON/text contracts.

Acceptance criteria:

- Parse extension params/catalogs and reject invalid structures, duplicate contract IDs/representation IDs, unknown selections and version mismatches. Keep identifier categories separate.
- Expose input/output schemas and capabilities for unknown domain contracts. Dynamic discovery remains runtime-validated data; generics must not manufacture static type safety.
- Enforce required/optional/none presence, explicit primary-Part metadata, contract/direction/representation identity and cardinality. Companion Parts remain unselected. JSON null, empty strings/objects/arrays and absence have distinct results.
- Implement JSON/text media matching and codecs against the verified carriers. Preserve payloads; reject non-JSON values, unsupported numeric/carrier ranges and unsupported formats without silent wrapping or coercion.
- Validate inline object/Boolean JSON Schema Draft 2020-12, the schema itself and the complete instance. Match declared vocabulary/format semantics; disable defaults, coercion and property removal. Native reference semantics and resource limits must be explicit.
- Return structured sanitized errors with draft-compatible detail and distinguish local programming errors from remote/protocol failures. Reject undeclared dialects/vocabularies and unavailable external dependencies early.
- Include normative fixtures, adversarial semantic tests, immutability checks and core API documentation. Core imports perform no hidden network I/O or environment/global configuration.

Evidence: Started/completed 2026-10-06, owner Codex; local working tree, no commit/PR or publication. [Inline core report](docs/inline-core-report.md), [public API/profile guide](js/README.md), [shared semantic fixtures](tests/inline-core-cases.json), ADR-008 and updated requirement/support maps. From `js/`: `npm exec --yes --package=node@22.23.3 -- npm run check:clean` and `npm exec --yes --package=node@24.21.0 -- npm run check:clean` pass fresh install/format/lint/strict types/build, 192 Vitest tests at 100% coverage, 20 original structural assertions, 32 shared semantic vectors and 14 installed-consumer checks per runtime. macOS arm64 reports: `js/reports/core-clean-node{22,24}.json`, `core-package-node{22,24}.json`, `core-summary.json`; zero development/installed runtime audit findings. Both artifact 0.1.0-dev.0 hashes: `580f4bb589b606d97bac3c4b882d096d20f90cb36fa517d944e88da23cc100f5`, retained under `js/artifacts/core-node{22,24}/`; original SDK-002 evidence preserved. Fixed preflight budgets and explicit official root-null refusal are documented; worker deadlines, HTTP adapter enforcement, activation/negotiation/lifecycle and Python/hosted CI remain downstream. SDK-004 is READY; M2 gate is not yet met.

## SDK-004: JS A2A client/server integration

Outcome: a complete installed-package path for discovery, activation, request validation, execution and validated response consumption.

Acceptance criteria:

- Provide server helpers to advertise configured contracts and integrate around public A2A SDK execution/event hooks without forking the SDK.
- Honor per-request activation and required-extension behavior. Baseline requests follow documented A2A behavior; optional activation does not leak between concurrent requests.
- Validate selected input before invoking the wrapped agent/model/tools or business processing. Tests directly prove zero wrapped-executor calls for invalid input.
- Validate outgoing contracted content before any successful contracted artifact/result publication. Preserve legitimate statuses/companion events and sanitize failures; prove an invalid output cannot already have escaped.
- Provide client discovery from an Agent Card/URL, explicit selection, schema exposure, local validation/encoding, activation, invocation, structured decoding and independent output/result-metadata validation.
- Preserve authentication/service parameters and request context supplied by the application. Define timeout, abort, cancellation and transport-error ownership; do not automatically retry side-effecting invocations.
- Demonstrate real JSON-RPC/HTTP round trips using the built package, plus a deliberately nonconforming peer and client-side rejection. Ship server and client quickstarts.

Evidence: Started/completed 2026-10-06, owner Codex; combined SDK-004/005 batch, local working tree, no commit/PR/publication. [Integration report](docs/integration-report.md), [public API/lifecycle/quickstarts](js/README.md), ADR-009 and updated requirement/support maps. From `js/`: `npm exec --yes --package=node@22.23.3 -- npm run check:clean` and `npm exec --yes --package=node@24.21.0 -- npm run check:clean` pass fresh install, format/lint/strict types/build, 248 Vitest tests (56 binding/transport plus 192 core/foundation), 17 installed-consumer checks and six HTTP/SSE quickstart assertions per runtime. Aggregate coverage: 92.52% statements / 90.88% branches / 95.41% functions / 96.81% lines; required core coverage remains 100%. Zero development/installed runtime audit findings. Reports: `js/reports/integration-summary.json`, `integration-clean-node{22,24}.json`/logs and `integration-package-node{22,24}.json`. Both artifact 0.1.0-dev.0 SHA-256 `3476778550e9b570bb60d7529faa6c7a63c4fee9d67f0911e879809cdd8f1bd4`, retained under `js/artifacts/integration-node{22,24}/`. Explicit atomic bounded profile, cooperative abort/cancellation and INPUT_REQUIRED continuation documented; AUTH_REQUIRED/immediate-return/append/replacement/record streaming, external resolution, synchronous worker isolation, Python and hosted CI excluded. SDK-006 and REF-001 are READY; M2 still requires REF-001/002.

## SDK-005: Complete Node presence, negotiation and lifecycle profile

Outcome: an inline delivery profile with complete documented edge-case and streaming behavior.

Acceptance criteria:

- Cover supported required/optional/none input/output combinations, text-to-JSON, JSON-to-text and schemaless interactions. No-input requests use a valid companion carrier; no-output success uses a valid completed Task without an empty Artifact.
- Enforce accepted representation IDs and A2A media-mode intersection, direction-specific selection fields and result echoes. Handle parameter/case comparison according to the recorded policy; no wildcard or suffix inference outside the draft.
- Specify input-required continuation, repeated calls and task/contract association without altering core state enums. Contract context survives where necessary, without allowing another request to change it silently.
- Define handling of multiple artifacts, conflicting primary metadata, append events, malformed result metadata and premature terminal states. Atomic schema-constrained payloads are validated before contracted publication; unfinished JSON is never success.
- Expose a clear asynchronous streaming API for permitted companion/status events and completed contracted results. Apply bounded buffering/backpressure and clean up on abort, task cancellation, disconnection and executor failure.
- Document transport/carrier limitations and add regression tests for lifecycle, correlation and concurrent requests. All advertised inline-profile features must be exercised through actual transport.

Evidence: Started/completed 2026-10-06, owner Codex; combined SDK-004/005 batch, local working tree, no commit/PR/publication. [Integration report](docs/integration-report.md), [public API/lifecycle/quickstarts](js/README.md), ADR-009 and updated requirement/support maps. From `js/`: `npm exec --yes --package=node@22.23.3 -- npm run check:clean` and `npm exec --yes --package=node@24.21.0 -- npm run check:clean` pass fresh install, format/lint/strict types/build, 248 Vitest tests (56 binding/transport plus 192 core/foundation), 17 installed-consumer checks and six HTTP/SSE quickstart assertions per runtime. Aggregate coverage: 92.52% statements / 90.88% branches / 95.41% functions / 96.81% lines; required core coverage remains 100%. Zero development/installed runtime audit findings. Reports: `js/reports/integration-summary.json`, `integration-clean-node{22,24}.json`/logs and `integration-package-node{22,24}.json`. Both artifact 0.1.0-dev.0 SHA-256 `3476778550e9b570bb60d7529faa6c7a63c4fee9d67f0911e879809cdd8f1bd4`, retained under `js/artifacts/integration-node{22,24}/`. Explicit atomic bounded profile, cooperative abort/cancellation and INPUT_REQUIRED continuation documented; AUTH_REQUIRED/immediate-return/append/replacement/record streaming, external resolution, synchronous worker isolation, Python and hosted CI excluded. SDK-006 and REF-001 are READY; M2 still requires REF-001/002.

## SDK-006: Secure Node external catalog/schema resolution

Outcome: optional, bounded HTTPS retrieval that cannot bypass validation or network policy.

Acceptance criteria:

- Implement external catalogs and schema documents, fragment/base URI/native JSON Schema resource handling and transitive dependencies. External catalogs meet immutability or integrity requirements. No implicit validator-controlled network fetch escapes the resolver.
- Define and enforce HTTPS-only defaults, credential exclusion, DNS/IP classification, redirect-by-redirect checks and binding the approved address policy to the actual connection. Block loopback/private/link-local/metadata targets unless explicitly allowed by administrator policy.
- Bound redirects, response bytes, elapsed time, reference graph count/depth/nesting and cache growth. Detect retrieval cycles while retaining valid supported local recursive-schema semantics; record ambiguity if the draft requires clarification.
- Verify declared SHA-256/SHA-512 integrity on the specified fetched representation before parsing. Define content-encoding/hash behavior, cache identity, immutable-resource reuse and handling of poisoned/mutable resources.
- Keep auth credentials in application configuration, never public metadata/logs/cache keys shared across identities. Restrict credential propagation on redirects and prevent cross-tenant cache disclosure.
- Add deterministic network-policy tests with controlled DNS/redirect/response fixtures; cover address changes, encoded host tricks, integrity mismatch, resource exhaustion and cancellation. Tests must not depend on arbitrary public hosts.
- Document secure configuration, administrator allowlisting, resolver limits and error behavior. Bundles/XML remain explicitly unsupported until their own tasks pass.

Evidence: Started/completed 2026-10-06 by Codex on local branch `codex/sdk-006-secure-resolution`; validation used the local working tree, subsequent checkpoint recorded in workspace CHECKPOINTS.md. [Resolver report](docs/resolver-report.md), [threat model](docs/resolver-security.md), [public API/configuration](js/README.md), ADR-010, support/requirement maps, and `js/reports/resolver-summary.json`. From `js/`: `npm exec --yes --package=node@22.23.3 -- npm run check:clean` and `npm exec --yes --package=node@24.21.0 -- npm run check:clean` each pass fresh install/format/lint/strict-types/build, 359 tests (109 resolver cases plus two integration cases added), 21 isolated installed-package checks, ten external HTTPS/A2A assertions and six retained inline HTTP/SSE assertions. Both final 0.1.0-dev.0 artifacts SHA-256 `d7c6886a7b672d17918f4b25f1896a412c2b9e132cd33581b41d56ebfd6f325d`, retained in `js/artifacts/resolver-node{22,24}/`; paired clean/package reports and logs retained. macOS arm64, exact A2A peer 1.3.0, core 100% coverage; aggregate 94.00/92.39/96.57/97.28 and resolver 97.79/96.20/100/98.43 coverage (statements/branches/functions/lines). Zero development/installed runtime audit findings; no new dependency, normative input modification or publication. I/O deadlines and connection-bound address/redirect policy, instance-private cache/auth, identity-encoded pre-parse integrity, per-preparation mutable snapshot consistency and bounded native graphs implemented. Local recursion allowed; separately retrieved cycles, nonlocal dynamicRef, encoded leading pointer slash, bundles/XML refused. Worker isolation/benchmarks/hosted portability remain SDK-007; independent reference security demonstrations remain REF-003. SDK-007 READY; M3 remains open.

## SDK-007: Node conformance, security and operational validation

Outcome: reviewable evidence that the Node release profile survives hostile inputs and realistic operation.

Acceptance criteria:

- Run the full pinned structural suite plus mapped semantic/binding/security cases from built artifacts. Use independent expected outcomes and property-based tests where they exercise invariants; do not mirror implementation logic.
- Prove invalid input has no business execution and invalid output has no successful contracted publication, including race/concurrency and streaming failure cases.
- Exercise malformed metadata, hostile schemas, deep/large payloads, unknown vocabulary behavior, regex work, reference exhaustion and bounded error counts. Synchronous validator work must have enforceable limits/isolation where required; an async timeout alone is insufficient.
- Verify abort/timeout/cancel cleanup, concurrent-request isolation, resource/cache bounds and no leaked handles. SDK behavior composes with existing A2A task storage instead of inventing a separate orchestration system.
- Provide optional structured diagnostic hooks for discovery, negotiation, validation and resolution, with correlation and duration and no payload/credential disclosure. No mandatory telemetry backend or global logger.
- Establish repeatable cold/warm validation and resolver benchmarks with documented inputs, limits, environment and regression tolerances chosen from evidence.
- Pass CI on the declared runtime/OS matrix, review dependency/license/security findings, and produce a machine-readable support/conformance report with test/requirement references and known exclusions.

Evidence: Started 2026-10-06 by Codex on `codex/m3-node-release-candidate`; operational isolation and independent installed-artifact security validation in progress. Completion gates remain open.

## SDK-008: Node developer documentation and release candidate

Outcome: a release-ready Node package that an unfamiliar developer can install and use correctly.

Acceptance criteria:

- Publish repository documentation for installation, client/server quickstarts, full public APIs/types, configuration, supported transports/dialects/vocabularies, presence, streaming, resolver policy and structured errors.
- Include migration/versioning policy distinguishing package, A2A protocol, extension URI, domain contract and schema versions. Supply troubleshooting, compatibility matrix, changelog, contribution guidance and vulnerability-reporting policy.
- Compile/type-check runnable documentation snippets and execute quickstarts using an isolated npm tarball; verify schema/license/resources and public exports are in the artifact. REF-004 supplies independent consumer evidence.
- Verify npm package name/scope ownership and complete metadata; keep publishing disabled until publication is separately requested. Prepare a tested dry-run/release workflow, immutable language-prefixed tags, artifact checksums and provenance/trusted-publishing configuration where supported.
- Verify minimum/maximum declared dependency compatibility and documented Node support. Resolve relevant high/critical findings, recording evidence instead of copying the draft lockfile.
- Record the Node milestone report. Every first-release-profile requirement is supported with evidence or explicitly rejected/documented; no full-draft claim.

Evidence: Not started.

## SDK-009: Python engineering and package foundation

Outcome: an idiomatic typed Python distribution, built after the validated Node candidate.

Acceptance criteria:

- Review the actual published Python SDK/validator artifacts and pin the development baseline. v1.2.2 is a research candidate, not an unverified support promise. Confirm interpreter/async/carrier compatibility and document Python-specific ADRs.
- Preserve `src/` layout; configure standards-based pyproject/build metadata, PEP 440 versioning, SPDX license metadata, explicit supported Python range and package resources. Include `py.typed` in installed artifacts.
- Set up Ruff formatting/linting, one strict type checker, pytest with explicit async mode, timeouts and meaningful coverage policies. Configure reproducible development dependencies without making end users install the development manager.
- Define minimal runtime dependencies, optional integrations/extras and async client/resolver resource ownership. Avoid implicit coercion via SDK/provider models; core imports have no environment or network side effects.
- Build wheel and sdist, validate their contents, rebuild from the sdist and install the wheel into a clean environment. Public imports/types/resources work without the source checkout or editable installation.
- Add interpreter-matrix CI and portability smoke tests with documented installation/contribution/check commands. Carry forward shared source pins and requirement maps.

Evidence: Not started.

## SDK-010: Independent Python inline client/server profile

Outcome: Python implements the complete Node inline profile using idiomatic public interfaces.

Acceptance criteria:

- Independently implement contract parsing, selection, metadata, media handling, presence and non-mutating validation against the original draft and shared expected outcomes, not a line-by-line TypeScript translation.
- Provide a typed public API with explicit missing-value semantics, documented dataclass/mapping/object boundaries, exceptions and asynchronous client/server adapters around public Python A2A SDK hooks.
- Preserve JSON null and supported JSON scalar/array/object values; reject nonfinite values and document cross-language precision/regex restrictions. Python bool/integer and SDK model coercion must not change acceptance.
- Match published JSON Schema vocabularies and annotation/assertion semantics, schema validation and supported reference handling. Required unsupported capabilities fail visibly.
- Complete discovery → activation → input validation → execution → output validation → client validation, including all supported presence/media/lifecycle/atomic streaming cases.
- Pass shared semantic cases and real Python transport tests, including zero execution for invalid input, no successful invalid output, nonconforming peer rejection and request isolation.
- Document Python client/server APIs and quickstarts as part of the task.

Evidence: Not started.

## SDK-011: Python secure resolution and operational parity

Outcome: Python satisfies the same first-release resolver and operational guarantees as Node.

Acceptance criteria:

- Implement external catalog/document resolution with the same policy and integrity semantics, using Python's native schema-resource handling behind the bounded resolver.
- Independently pass DNS/connection binding, redirect/address, credential/cache partition, integrity, graph/resource limit and cancellation tests. No automatic external-reference loader bypasses policy.
- Enforce validator execution budgets and avoid blocking unbounded work on the async event loop; document worker/isolation/resource choices and their limits.
- Match sanitized errors, diagnostic hooks, correlation, concurrent-request isolation and cancellation/cleanup behavior without requiring a telemetry backend.
- Run mapped conformance/security cases and repeatable performance baselines against installed wheels. Compare semantic decisions with Node; validator message wording may differ.
- Update the Python support matrix, resolver documentation and threat model. Bundles/XML stay unsupported until later coverage tasks.

Evidence: Not started.

## SDK-012: Python developer documentation and release candidate

Outcome: a release-ready Python package with independently verified consumer and parity evidence.

Acceptance criteria:

- Deliver Python installation, client/server and async lifecycle guides; public API/type documentation; resolver/security/error references; compatibility and migration guidance.
- Execute documentation examples from installed wheels. Build/rebuild wheel/sdist, verify types/resources/license and run package metadata checks in isolation.
- Verify PyPI distribution-name ownership and metadata. Prepare tested dry-run release configuration, language-prefixed immutable tags, checksums and trusted-publishing/provenance configuration where supported; publishing stays disabled until separately requested.
- Pass interpreter/dependency-bound CI and security/license review. Document all implementation differences and supported restrictions, without claiming conformance beyond the evidence.
- Consume REF-006's four-pairing report and close any semantic discrepancies. Provide a Python release-candidate report tied to exact artifact hashes and contract revision.

Evidence: Not started.

## SDK-013: Joint release rehearsal and maintenance readiness

Outcome: both language packages can be maintained and released independently without compatibility ambiguity.

Acceptance criteria:

- Rehearse independent JS/Python releases from immutable source revisions without publishing. Confirm one package's version change does not implicitly change the other package or contract identity.
- Connect artifact production to REF-008's isolated consumers using exact SDK artifact versions/hashes. Document the reference revision corresponding to each candidate.
- Finalize compatibility/deprecation policies, support lifecycle, release checklist, changelog/tag conventions, security-reporting ownership and dependency-update validation.
- Configure least-privilege CI, protected release workflows when remote infrastructure exists, lockfile/update automation and artifact provenance/SBOM/license reports appropriate to shipped dependencies.
- Include clean-checkout support, backup/recovery for failed release steps and package-publishing setup instructions. Remote setup not yet available is an explicit open item, not claimed complete.
- Produce a first-release readiness report with requirement coverage, benchmark/support matrix, residual restrictions and executable validation instructions.

Evidence: Not started.

## SDK-014: Safe schema-bundle support in both languages

Outcome: complete integrity-pinned JSON Schema bundle support, beyond the first release profile.

Acceptance criteria:

- Define supported archive formats and reproducible entrypoint/dependency semantics in an ADR aligned with the draft; verify archive integrity before parsing/extraction.
- Prevent absolute/escaping paths, symlinks, duplicate normalized paths, decompression bombs and uncontrolled dependency escape. Bound entry counts, sizes and expanded bytes; cleanup is reliable.
- Resolve bundled native schema references within the policy-controlled resource graph. Do not silently fall back to arbitrary network retrieval.
- Independently implement and validate Node/Python behavior, matching shared success/refusal cases and sanitized errors.
- Ship consumer documentation, secure configuration, conformance evidence and artifacts containing the required implementation resources. Update support claims only after this task passes.

Evidence: Deferred; excluded from first release gates.

## SDK-015: Explicit XML/XSD validation support in both languages

Outcome: documented, complete validation for explicitly selected XSD dialects.

Acceptance criteria:

- Research and select maintained validator integrations, supported XSD versions, native/runtime licensing implications and supported platform matrix. Document capabilities; do not promise arbitrary XSD support.
- Preserve XML instance versus schema-document media types and implement explicit XML codecs/primary-Part validation without translating XSD into JSON Schema.
- Resolve include/import graphs through the existing secure document/bundle resolver. Disable external entities, uncontrolled DTD/XSLT/network processing and bound resource work.
- Implement and validate both client and server boundaries in both languages, including malformed XML, prohibited entities, schema dialect mismatch, include/import failures and invalid generated XML.
- Ship isolated package/optional-extra installation evidence, API/security/troubleshooting guides, and cross-language semantic cases. Update the support matrix and role coverage; propose draft clarifications separately where necessary.

Evidence: Deferred; excluded from first release gates.

## Progress log

| Date | Task | Update | Evidence |
|---|---|---|---|
| 2026-10-06 | Planning | 15 deliverable tasks recorded; SDK-001 is READY; implementation remains unstarted | This plan; workspace PREP-003 |
| 2026-10-06 | SDK-001 | DONE; published compatibility, role requirement map, ADRs and supported restrictions recorded | docs/research-report.md; 30 probes per supported runtime; 20 structural checks |
| 2026-10-06 | SDK-002 | DONE; strict ESM package, fresh toolchain/lock, verified resources, configured CI and clean tarball consumers | docs/foundation-report.md; both Node 22/24 clean gates pass; SDK-003 READY |
| 2026-10-06 | SDK-003 | DONE; offline inline core and public APIs, frozen validation/metadata/codecs/errors, shared vectors and installed examples | docs/inline-core-report.md; 192 tests/100% coverage and 14 consumer checks on fresh Node 22/24; SDK-004 READY |
| 2026-10-06 | SDK-004/005 | Combined inline HTTP/SSE batch DONE locally; SDK-006 READY | Integration report and paired clean/installed-artifact evidence |

| 2026-10-06 | SDK-006 | DONE locally; SDK-007 READY | Resolver report: 359 tests and 21 installed-consumer checks on fresh Node 22/24; explicit HTTPS policy, graph/integrity/auth/cache and public transport evidence; worker/operational validation remains next |

## Public repository availability

The maintainer authorized public GitHub repository creation on 2026-10-06.
The repository front page, description, discovery topics and contributor/security
guides distinguish the implemented Node preview from planned Python and release
work. Original task reports retain their validation-time context. Source hosting
does not publish an npm/PyPI package or close the remaining release gates.

The [first successful hosted launch gate](https://github.com/shashikanth-gs/a2a-schema-contract-sdk/actions/runs/37497396103) validates source
`6d51d99e2b7804586bbc222fd650a93bde73d6c0` on Linux Node 22.23.3/24.21.0
and macOS/Windows Node 24.21.0, including behavioral/installed-package checks,
compatibility probes and audits. Initial checkout-byte/runtime/test-start issues
were corrected without changing validator behavior or skipping checks. This
adds hosted baseline evidence; SDK-007 and the release milestones remain open.


| 2026-10-06 | SDK-007/008 candidate work | Owned workers, sanitized hooks, operational/invariant tests, unscoped 0.1.0-rc.0 metadata, installed structural/worker/benchmark gates and disabled publication rehearsal implemented. Fresh Node 22/24 checks pass; hosted and independent reference acceptance remain open. | docs/node-operations.md; docs/node-release.md; js/reports/rc-* |
