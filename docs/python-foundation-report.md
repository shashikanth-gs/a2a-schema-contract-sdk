# Python engineering foundation acceptance

Date: 2026-10-13. SDK-009 complete locally; SDK-010 ready.

This accepts an engineering/package foundation, not the complete Python protocol
implementation. Contract discovery/selection, client/server execution, atomic
streaming/continuation, secure external resolution, isolated async validation and
the four Python/Node pairings remain SDK-010/011 and REF-005/006 gates. No Node
runtime, adapter runtime or normative input changed.

## Profile and architecture

CPython 3.11.15, 3.12.13, 3.13.14 and 3.14.7 on local macOS arm64. Core standard
library types and JSON boundaries import no validator, official SDK or framework.
Small typed ports point inward; jsonschema/referencing and optional A2A protobuf
integration are outer infrastructure. See [ADRs](python-architecture.md) and the
[Python contributor/API guide](../python/README.md).

PEP 517/518/621 src-layout package; hatchling 1.32.4; PEP 440 `0.1.0.dev0`;
SPDX Apache-2.0; installed py.typed, seven byte-pinned draft schemas and attribution.
The runtime requires jsonschema 4.26.0/referencing 0.37.0. Optional official A2A
1.2.2/http-server extras contain no framework/model provider. uv 0.12.1's committed
hash lock controls development. Ruff 0.17.0, strict mypy 2.4.0, pytest 9.1.1,
pytest-asyncio 1.4.0 and pytest-timeout 2.4.0 are the single-tool baseline.

## Executed evidence

`cd python`:

```sh
uv sync --locked --all-extras --python 3.12
uv run ruff format --check src tests scripts
uv run ruff check src tests scripts
uv run mypy
uv run pytest -q --cov --cov-report=term-missing
uv run coverage json --include='*/core/*' --fail-under=100 -o reports/core-coverage.json
uv run python scripts/check_package.py
uv run python scripts/check_matrix.py
uv run pip-audit --local --format json --output reports/dependency-audit.json
```

The matrix creates a fresh locked environment for each interpreter and repeats
quality, behavior, core coverage and installed-artifact checks. Every profile
passes **189 tests**, including the 24 shared validation/media cases and **24
published A2A compatibility/carrier/lifecycle probes**. Core statement/branch
coverage is 100%; overall coverage is 95.99% on 3.11–3.13 and 95.97% on 3.14,
above the enforced 90% floor. No skipped behavioral tests or weakened type checks.
Core/native reference/schema expectations and malformed input remain separate
from future full contract/payload/transport conformance.

All four profiles independently build wheel/sdist, reproduce the same wheel from
sdist, pass strict Twine metadata checks and install noneditable wheels outside
the checkout. Core consumers have no official A2A or development dependencies.
Server-extra consumers use public carrier/route imports. README Python examples
execute from the installed wheel; strict installed consumers check public types.
Every interpreter produces identical artifact hashes:

| Artifact | SHA-256 |
| --- | --- |
| `a2a_schema_contract-0.1.0.dev0-py3-none-any.whl` | `43aa04858f1bc83f53a1745210d68166f9d031294aba1ed5de588b56eb9a129a` |
| `a2a_schema_contract-0.1.0.dev0.tar.gz` | `dd18637dadecd3c921334d7913e90cb250c6971e48000cbfd9e5b0daea541625` |

The [receipt](evidence/python-foundation/receipt.json) retains pins, profiles,
checksums and audit summary. Generated per-runtime logs, coverage/audit reports
and package receipts live in ignored `python/reports/`; artifacts in `python/dist/`.
The scripts reproduce them. The workflow pins actions and configures Linux
3.11–3.14 plus macOS/Windows 3.14 checks. Hosted jobs have not been run or accepted.

## Compatibility and security findings

Public SDK hooks support operation metadata, per-call activation/version headers,
protobuf Part conversion, public executors/event queues/context and route factories.
No source snapshot/private SDK hook is imported. Mock HTTP tests verify original
headers/body and response conversion; local cancellation cleans up without closing
the application-owned HTTP client. These are compatibility probes, not an actual
Python Schema Contract server round trip.

Protobuf preserves root JSON null, nested null, empty text and JSON scalars/arrays.
It normalizes JSON numbers to binary64 and can discard null non-oneof fields;
original values must be guarded before parsing. Boolean/integer coercion and
nonfinite/unsafe values are rejected. Root null remains unsupported by Node peers.
Portable regex end-anchor compilation preserves ECMA-262 behavior, property
evaluation and native pointer/dynamic references without changing advertised schemas.

The current development environment audit checks 92 dependencies and reports zero
known vulnerabilities. The unpublished SDK itself is explicitly skipped by pip-audit
and reviewed through source/tests; the skip is not a zero-vulnerability claim about
this package. jsonschema/referencing/rpds use MIT and the official A2A SDK uses
Apache-2.0; runtime notices/SDK licensing remain compatible with Apache-2.0.
No newly broadened dependency ranges or untested platform support are inferred.

Synchronous validation remains trusted calling-thread work; hard execution limits,
untrusted server admission, resolution policy and lifecycle parity remain SDK-011.
No publishing, tag, remote branch push or PyPI ownership assertion occurred.
