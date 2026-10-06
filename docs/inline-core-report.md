# SDK-003 inline core completion evidence

Completed locally on 2026-10-06, owner Codex. Source is the local working tree;
no commit, PR or publication. This completes the offline framework-independent
core task, with installed artifact evidence on macOS arm64. A2A adapter,
transport, lifecycle, security isolation and Python work remain downstream.

## Delivered behavior

- Pinned structure validation for catalogs, params and invocation/primary/result
  metadata; exact draft URI, explicit versioned IDs, unique contracts and
  direction-local representation IDs; unknown selections fail.
- Frozen dynamic discovery and capability diagnostics with visible unsupported
  alternatives; selected inline schemas are meta-validated/compiled before any
  instance processing. No manufactured TypeScript business generics.
- Required/optional/none presence, explicit primary identity/cardinality and
  independent result validation. Same-media companions remain unselected.
- JSON/text encoding and decoding preserve null, nested null, empty strings,
  objects/arrays and numeric/Boolean values. The explicit official 1.3.0 carrier
  profile rejects root data:null on input/output before codec loss.
- Non-mutating Draft 2020-12 object/Boolean schema validation with annotation
  format/content semantics, native local pointers/anchors/resources/recursive
  dynamic-anchor refs and explicit unsupported-feature diagnostics.
- Bounded immutable snapshots reject non-JSON values, unsafe/nonfinite numbers,
  proxy/accessor/symbol/cycle/sparse-array inputs; portable regex/number/reference
  profiles and fixed resource budgets are documented in ADR-008.
- Sanitized local/remote errors expose valid pinned draft detail only when a
  usable contract/direction is known. No values, raw causes or validator paths.
- Core imports do no compilation, file/network I/O or global configuration.
  Build embeds structures only after verifying the immutable vendor hashes.

Public APIs, exact grammar, limits, errors and synchronous ownership are in the
[package README](../js/README.md). The [core example](../js/examples/core.mjs),
[discovery snippet](../js/examples/discovery.mjs) and resource example execute
from an installed tarball without the official peer or source checkout.

## Acceptance and tests

| SDK-003 criterion | Reviewable evidence |
|---|---|
| Structures, IDs, duplicates, selection, versions | `core.test.ts`: pinned structures and discovery; all 20 upstream structural decisions retained |
| Unknown-domain schemas/capabilities and truthful types | Discovery tests; installed unknown-domain example; strict consumer rejects invented domain assignment |
| Presence/primary identity/cardinality/companions | Primary/carrier/presence/invocation/result test groups; both core directions |
| Media/codecs and complete unchanged values | Round trips, empty/null vectors, official root-null guard, unsupported media/carrier/numeric vectors |
| Schema validity/vocabularies/complete instance/native refs | JSON Schema profile group: meta-invalid schemas, Boolean/annotation/unevaluated/applicator/local/dynamic/reference tests |
| Structured errors and early unsupported dependencies | Schema capability failures precede instance validation; Ajv reserved-map omission explicitly refused; external params/ref/bundle/dialect rejection; errors validate original draft schema |
| Fixtures, adversarial semantics, immutability, docs/offline imports | 32 language-neutral cases plus descriptor/proxy/accessor/cycle/depth/node/byte/schema/ref/regex tests; frozen callers/catalogs; package examples |

[Behavior tests](../js/test/core.test.ts) contain **187 core tests**, including
32 shared semantic vectors and a test containing 20 upstream structural fixture
assertions. Five foundation tests bring the total to **192 passing Vitest tests**.
Coverage is **100% statements, branches, functions and lines** on both supported
runtime versions. Thresholds remain 100%; no core checks were skipped.
[Shared fixtures](../tests/inline-core-cases.json) preserve stable decisions for
independent Python implementation later. The [requirement map](requirements.md)
marks core evidence separately from pending binding/security responsibilities.

## Reproducible artifact/environment evidence

Run from `js/` (shell commands use the workspace RTK wrapper):

```sh
rtk npm exec --yes --package=node@22.23.3 -- npm run check:clean
rtk npm exec --yes --package=node@24.21.0 -- npm run check:clean
rtk proxy npm audit --json > reports/core-audit.json
```

Each clean gate performs fresh `npm ci`, build/hash verification, format, lint,
strict types, all tests/coverage, and 14 isolated installed-consumer checks.
Temporary source copies have no `inputs/`, prior node_modules/builds or reports.
Core installs without the optional A2A peer; installed public declarations and
JavaScript examples work before exact peer 1.3.0 is installed. Private paths are
refused; resource/license hashes match the original pinned snapshot. Exact peer
minimum and maximum are both 1.3.0. Runtime Ajv remains 8.20.0; dependencies and
lock classifications are unchanged. Development and installed runtime audits
report zero vulnerabilities.

| Runtime / environment | Clean report | Installed report | Retained artifact |
|---|---|---|---|
| Node 22.23.3 / macOS arm64 | [core-clean-node22.json](../js/reports/core-clean-node22.json) | [core-package-node22.json](../js/reports/core-package-node22.json) | [Node 22 tarball](../js/artifacts/core-node22/shashikanth-gs-a2a-schema-contract-0.1.0-dev.0.tgz) |
| Node 24.21.0 / macOS arm64 | [core-clean-node24.json](../js/reports/core-clean-node24.json) | [core-package-node24.json](../js/reports/core-package-node24.json) | [Node 24 tarball](../js/artifacts/core-node24/shashikanth-gs-a2a-schema-contract-0.1.0-dev.0.tgz) |

Both **0.1.0-dev.0** artifacts have identical SHA-256:
`580f4bb589b606d97bac3c4b882d096d20f90cb36fa517d944e88da23cc100f5`. This local development version is separate
from the extension URI, contract IDs, A2A 1.0 and JSON Schema dialect. No package
publication occurred. Original SDK-002 reports remain unchanged; its tarball is
retained in `js/artifacts/sdk-002/`. Machine summary: [core-summary.json](../js/reports/core-summary.json);
audit: [core-audit.json](../js/reports/core-audit.json). Clean command logs are
stored beside each clean report.

## Remaining gates

Fixed preflight budgets do not establish an enforceable wall-clock deadline or
worker isolation; SDK-007 owns synchronous-work isolation and hostile performance
validation. Direct root-only self-refs are refused at compile time; other
non-progressing cycles/evaluation stack exhaustion produce `RESOURCE_LIMIT`.
Supported bounded local recursive instances have positive tests. No general
full-dialect or secure arbitrary-schema execution claim is made.

Actual HTTP activation, raw guard placement, zero executor/task-store mutation,
failed-Task output mapping, Task/Message/result metadata placement, output-mode
negotiation, concurrent requests, streaming/cancellation and continuation are
SDK-004/005/007 acceptance gates. SDK-004 must always choose the explicit official
carrier profile. External resolution remains disabled until SDK-006; bundles,
XML and Python/parity are deferred to their planned tasks. Hosted CI/OS evidence
is pending. Root M2 remains planned; only SDK-003 becomes DONE and SDK-004 READY.

Final-review correction: preliminary 188-test / 13-consumer-check evidence is
preserved at `js/reports/core-review-pre-proto-guard/` and corresponding archived
tarballs. It does not establish rejection of Ajv-ignored schema-map entries.
Final reports supersede it with the explicit guard, special-property regressions,
32 shared vectors and installed-artifact rejection. Normative inputs are unchanged.
