# Shared Node SDK developer-experience validation

SDK-016–019 implement ADR-013 for the private
`a2a-schema-contract@0.1.0-rc.1` candidate. The normative source remains
`a5c007510faa3fce85190f2e76e402faf0e897ad` and the extension URI remains
`https://w3id.org/a2a-schema-contract/draft/0.1`. Original M3/RC0 reports retain
their historical scope. This report owns the additional application APIs.

## Implemented behavior

| Task    | Public behavior                                                                                                                                                                 | Acceptance evidence                                                                                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK-016 | `describeContracts()` and async `client.describe()` join advertised skills to all matching contracts, with capabilities, unmapped contracts and stale associations              | Many-to-many, missing/stale skills, duplicate IDs, immutable views and unsupported alternatives in `js/test/developer-experience.test.ts`; peer-free installed example and strict consumer                             |
| SDK-017 | `catalog.schema()` exposes immutable descriptor, entry and original resource documents without network access or compilation                                                    | Inline, Boolean, schemaless, unsupported, redirected external roots, native aliases, fragment entry and root anchors; cache-clear and mutation isolation in developer-experience/resolver suites                       |
| SDK-018 | `createContractExtension()`, server `catalogDelivery`, `selectInvocation()` and `client.invokeContract()` compose advertisement and explicit selection with existing validation | Embedded/external acquired-catalog provenance; no params replacement; ambiguous/invalid input before dispatch; structured and text-to-JSON round trips; unrelated metadata/extensions retained                         |
| SDK-019 | Explicit A2A 1.0 metadata binding and independently authored wire fixtures                                                                                                      | Direct request, independently supplied response, conflicting Message placement, required result echo and optional activation response header; [binding guide and clarification](metadata-binding.md), `tests/binding/` |

An external-resource regression exposed an Ajv registration gap for an anchor
declared at a document root without `$id`. The compiler now registers that
anchor identity while preserving original schema values and native resource
bases. The independently authored redirected-root/fragment fixture checks both
resource identities and actual instance validation. The existing resolver profile
and its limits remain unchanged.

## Fresh local evidence

On 2026-10-07, `npm run check:clean` passed on **Node 22.23.3 and 24.21.0**,
macOS arm64. Each run installs locked dependencies into a fresh source copy and
executes formatting, lint, strict types, **406 tests with no skips**, coverage,
build, isolated tarball consumers, structural fixtures, hostile-worker checks,
benchmarks and dependency audits. There are **28 installed-package checks**,
including the new peer-free discovery example and immutable strict types.
Runtime and development audits report zero vulnerabilities. Core coverage meets
the existing 100% gate; aggregate coverage is 95.81% statements, 93.62% branches,
97.68% functions and 97.70% lines.

Reports: `js/reports/dx-clean-node{22,24}.json`, their logs,
`dx-package-node{22,24}.json` and `rc-dependencies-node{22,24}.json`.
Both fresh builds produce SHA-256
`09c0146a2d9d1ba110fd6d888374ce0233f8effc1df77dc42f6a167bd4717677`.
`npm run release:rehearsal` verifies reproducible packs; publication stays disabled.

Hosted validation and the independent REF-010 source/artifact pin are pending
this implementation checkpoint. They must pass for the current candidate before
M3a closes; earlier RC0 hosted runs do not establish this candidate's acceptance.

## Consumer and language boundaries

See [the API guide](developer-experience.md), the executable
`js/examples/developer-experience.mjs`, strict `discovery-types.ts` and the
[independent flight tutorial](https://github.com/shashikanth-gs/a2a-schema-contract-reference/blob/codex/m3-node-release-candidate/docs/discovery-tutorial.md).
The reference provider owns its schemas; ordinary JS/TS consumers discover them
from the Agent Card and consume installed public imports.

Python SDK-010/011 and REF-006 must independently reproduce the same discovery,
selection, original-resource and wire-fixture outcomes. SDK types do not claim a
dynamic JSON schema is a static application domain type. Associations never imply
routing. Provider-specific schema conversion, model execution, framework tools
and delegation belong to separate adapters. No ADK/LangGraph dependency, Python
parity, live-model test, arbitrary-schema compatibility, bundle/XML support,
upstream endorsement or registry publication is claimed.
