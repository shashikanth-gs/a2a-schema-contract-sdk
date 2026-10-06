# A2A Schema Contract SDK

Reusable client and server libraries for the A2A Schema Contract extension.

**Status: SDK-001–006 complete locally.** The installed Node package implements offline validation plus official A2A 1.3.0 HTTP/SSE client/server integration, activation, negotiation, atomic output and continuation/cancellation. Explicit HTTPS external catalog/schema resolution is available; SDK-007 operational validation is next; Python remains a scaffold. Package ownership is provisional and publishing is disabled.

## Layout

| Directory | Purpose |
|---|---|
| `js/` | TypeScript source for an installable JavaScript package |
| `python/` | Independently installable Python package |
| `tests/` | Shared behavioral test specifications and conformance integration |
| `docs/` | Accepted architecture, support/requirement maps and completion evidence |
| `research/` | Reproducible published-artifact compatibility probes |
| `vendor/contract/` | Byte-for-byte pinned upstream schemas/fixtures with SHA-256 manifest and attribution |

Each language will provide shared contract handling, client support, server support, and adapters around the official A2A SDK. Generation adapters can follow separately.

JS and Python may release independently. Both must declare their supported contract version. The initial source is pinned in [contract-source.json](contract-source.json).

## Specification and consumers

- Specification: https://github.com/shashikanth-gs/a2a-schema-contract
- Planned reference repository: `shashikanth-gs/a2a-schema-contract-reference`

Normative schemas and conformance fixtures remain owned by the specification repository. The verified vendor snapshot is an immutable copy of the pinned Git object; it is not an independent specification. Builds verify hashes and copy resources offline. No runtime imports from workspace inputs are permitted.

## Development sequence

1. Research and pin the Node SDK and validator dependencies.
2. Implement the JS client/server packages.
3. Validate real package consumption in the reference repository.
4. Implement Python independently.
5. Validate both languages against shared fixtures and against each other.

In `js/`, use Node 22 >=22.23.3 or 24 >=24.21.0 and run `npm ci` then `npm run check`.
`npm run check:clean` repeats the full gate in a new temporary source copy. Node
22/24 checks and tarball consumers pass on macOS arm64. Hosted Linux/macOS/Windows
CI is configured, with actual hosted execution still pending remote setup.

See the [research report](docs/research-report.md), [foundation report](docs/foundation-report.md), [inline core report](docs/inline-core-report.md), [integration report](docs/integration-report.md),
[resolver report](docs/resolver-report.md), [resolver threat model](docs/resolver-security.md),
[support matrix](docs/support-matrix.md) and [Node package README](js/README.md).

See [PLAN.md](PLAN.md) for the tracked implementation tasks, acceptance criteria and release gates.
