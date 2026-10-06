# A2A Schema Contract SDK

TypeScript and JavaScript client/server libraries for the **A2A (Agent2Agent)
Schema Contract extension**. Discover an agent's input and output contracts,
validate JSON or text against those contracts, and exchange validated results
over A2A.

An agent advertises a catalog in its Agent Card. A client discovers the catalog,
selects a contract and representation, and activates the extension. The SDK
validates input before business execution and validates complete output before
publishing a successful contracted result. The client also validates the peer's
response.

**Node SDK:** the Node implementation supports the community draft
`v0.1.0-draft.1`. Python support is planned. npm and PyPI packages have not been
published; use the source checkout or a locally built npm tarball. Worker
isolation and operational validation pass the supported hosted matrix. See the
[support matrix](docs/support-matrix.md) for the precise supported profile.

## What you can build

- A2A agents that advertise versioned input/output contracts and reject invalid input before calling application code, models or tools.
- Clients that discover unfamiliar contracts, inspect schemas, negotiate representations and validate responses.
- JSON Schema Draft 2020-12 validation for JSON and text payloads, with required, optional and absent directions.
- HTTP and SSE exchanges with companion events, bounded atomic output and task continuation/cancellation.
- Explicit HTTPS resolution of external catalogs and schema graphs, with integrity checks, DNS/IP policy, redirect checks and private credential/cache ownership.

The SDK preserves caller data: validation does not insert defaults, coerce values
or remove properties. Dynamic discovery returns runtime-validated JSON; it does
not invent a statically known domain type.

## Shared application APIs

The Node SDK adds skill-associated discovery, immutable prepared-schema resource
views, compact explicit invocation and validated embedded/external advertisement.
These APIs belong in the shared SDK; future framework adapters consume them.
See [developer experience](docs/developer-experience.md) and
[metadata binding](docs/metadata-binding.md). Python parity remains planned.
The current private Node candidate is `0.1.0-rc.1`; the earlier hosted `rc.0` evidence
does not establish hosted acceptance of these additions.

## Get started

Use Node **22 >=22.23.3** or **24 >=24.21.0**, npm and ESM.

```sh
git clone https://github.com/shashikanth-gs/a2a-schema-contract-sdk.git
git -C a2a-schema-contract-sdk checkout codex/m3-node-release-candidate
cd a2a-schema-contract-sdk/js
npm ci
npm run build
node examples/core.mjs
node examples/http.mjs
```

The HTTP example starts a local agent, discovers its contract, completes a
validated exchange, checks invalid-input/output behavior, consumes an SSE result
and closes its server. It requires no model-provider credentials.

Run `node examples/external.mjs` for the HTTPS catalog/schema-resolution example.
It uses an explicitly allowlisted local endpoint and a public test-only TLS
fixture. Read the [resolver security model](docs/resolver-security.md) before
configuring external retrieval in an application.

Build an installable development artifact from `js/`:

```sh
npm pack
```

Install the resulting `.tgz` in your application. The optional official A2A adapter
peer is **`@a2a-js/sdk@1.3.0`**. Core validation and the HTTPS resolver can be
installed without that peer. Express is an example host dependency.

## Documentation

| Start here | What it covers |
|---|---|
| [Node API and quickstarts](js/README.md) | Public imports, client/server integration, schema validation, negotiation, lifecycle and resolver configuration |
| [Reference applications](https://github.com/shashikanth-gs/a2a-schema-contract-reference) | Independent installed-package clients/agents and 37 reproducible inline scenarios |
| [Schema Contract specification](https://github.com/shashikanth-gs/a2a-schema-contract) | Normative community draft, extension schemas, identifiers and conformance fixtures |
| [Support matrix](docs/support-matrix.md) | Supported runtimes, transport, media, schema profile and limitations |
| [Architecture](docs/architecture.md) | Implementation decisions and their rationale |
| [Resolver threat model](docs/resolver-security.md) | Network policy, integrity, credential/cache boundaries and resource limits |
| [Roadmap](PLAN.md) | Completed deliverables and remaining work |

The extension URI is `https://w3id.org/a2a-schema-contract/draft/0.1`.
Package versions, protocol versions, contract IDs and schema dialects have
separate meanings. The pinned specification revision is recorded in
[contract-source.json](contract-source.json).

The current adapter supports **A2A 1.0 JSON-RPC over HTTP and SSE**. JSON Schema
uses the documented Draft 2020-12 validator profile. Root JSON null is unsupported
by the official adapter; nested null is preserved. Bundles, XML/XSD, other
transports and Python interoperability are future work.

## Validate and contribute

From `js/`:

```sh
npm run check
npm run check:clean
```

`check` builds and runs formatting, lint, strict TypeScript, behavioral tests and
isolated installed-package checks. `check:clean` repeats the gates in a temporary
source copy. The Node candidate passes **381 tests, 26 installed-consumer checks
and 20 pinned structural cases** on Node 22.23.3 and 24.21.0. The
[candidate report](docs/node-candidate-report.md) records exact artifact hashes,
hosted Linux/macOS/Windows evidence and limitations. CI results are available in the repository's
[Actions](https://github.com/shashikanth-gs/a2a-schema-contract-sdk/actions) tab;
local reports retain their original validation context.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development expectations and
[SECURITY.md](SECURITY.md) for private vulnerability reporting. Use
[issues](https://github.com/shashikanth-gs/a2a-schema-contract-sdk/issues) for bugs
and feature requests, and
[discussions](https://github.com/shashikanth-gs/a2a-schema-contract-sdk/discussions)
for usage questions.

## Repository layout

| Directory | Contents |
|---|---|
| `js/` | TypeScript source, JavaScript package, tests and executable examples |
| `python/` | Scaffold for the planned independent Python SDK |
| `docs/` | Architecture, support/requirement maps and validation evidence |
| `tests/` | Shared behavioral cases |
| `vendor/contract/` | Verified, attributed snapshot of the pinned specification resources |
| `research/` | Published A2A SDK compatibility probes |

Licensed under [Apache-2.0](LICENSE).


The candidate uses the unscoped **`a2a-schema-contract`** name. Async transport
validation and resolver compilation run in owned workers with bounded deadlines,
heap limits, concurrency and physical cleanup. Optional diagnostics omit payloads
and credentials. See the [operations guide](docs/node-operations.md),
[release policy](docs/node-release.md) and [changelog](CHANGELOG.md).
`npm run release:rehearsal` performs a dry run and two reproducible packs; it never
publishes or creates a release tag. Candidate CI evidence is tracked in PLAN.md.
