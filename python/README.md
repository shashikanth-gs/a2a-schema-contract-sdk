# A2A Schema Contract for Python

An independent implementation of the pinned Schema Contract community draft.
The `0.1.0.dev0` engineering foundation provides strict JSON values, offline schema
validation, installed draft resources and a guarded optional A2A Part boundary.
Complete discovery, client/server execution, streaming, secure external resolution
and cross-language acceptance are subsequent gates. This artifact is not a Python
release candidate; no package has been published.

## Installation

Python 3.11–3.14. Applications install an ordinary wheel; uv is a development tool.

```sh
python -m pip install dist/a2a_schema_contract-0.1.0.dev0-py3-none-any.whl
# Optional official A2A integration:
python -m pip install 'dist/a2a_schema_contract-0.1.0.dev0-py3-none-any.whl[a2a]'
```

Core uses `jsonschema==4.26.0` and `referencing==0.37.0`. The `a2a` extra adds
`a2a-sdk==1.2.2`; `server` adds its HTTP-server dependencies. Framework/model
dependencies belong in independent adapter packages.

## Non-mutating validation

```python
from a2a_schema_contract import MISSING
from a2a_schema_contract.validation import validate_value

request = {"origin": "DEL", "destination": "BOM"}
checked = validate_value(request, schema={
    "type": "object",
    "required": ["origin", "destination"],
    "properties": {
        "origin": {"type": "string", "pattern": "^[A-Z]{3}$"},
        "destination": {"type": "string", "pattern": "^[A-Z]{3}$"},
    },
    "additionalProperties": False,
})
assert checked == request and checked is not request
assert MISSING is not None  # absence differs from present JSON null
```

`snapshot(value)` accepts exact JSON builtins: dicts with string keys, lists,
strings, finite portable numbers, booleans and `None`. It refuses dataclasses,
Pydantic objects, arbitrary Mappings, tuples, subclasses and conversion hooks.
Convert trusted application objects explicitly. `loads(text)` also refuses
duplicate keys. Validation never coerces, inserts defaults, removes properties,
or mutates input. Returned values are detached JSON trees, not inferred business types.

The Draft 2020-12 profile retains the Node restrictions: formats/content are
annotations; unsupported assertions, dialects and required vocabularies fail
visibly; regexes use a bounded ASCII grammar; integers stay within ±(2**53−1);
`multipleOf` uses positive integers. Local recursive references are supported.
No automatic network loader exists. Missing external refs fail during preparation
even if the current value would not traverse them.

Synchronous helpers run on the calling thread and are for trusted bounded work.
Isolated async validation with hard budgets and safe untrusted server admission
are SDK-011 work. A thread timeout does not prove validation stopped.

## Optional A2A carrier boundary

```python
from a2a_schema_contract.adapters.a2a import part_from_wire, part_to_wire

assert part_to_wire(part_from_wire({"data": {"nested": None}})) == {
    "data": {"nested": None}
}
assert part_to_wire(part_from_wire({"text": ""})) == {"text": ""}
```

Original JSON is checked before protobuf can normalize or discard it. This guards
carrier cardinality, original types, metadata and portable numbers. Python preserves
root JSON null; the accepted JS adapter rejects it. Root null remains unsuitable
for a Node peer. Protobuf numbers may return as floats: `1` and `1.0` share JSON
Schema integer semantics; booleans do not.

Applications own configured transports, auth, agents/models, cancellation policy,
and persistence. Local coroutine cancellation differs from remote CancelTask.
Importing the root loads no official SDK, transport, validator or framework,
changes no environment variables, and performs no network access.

## Resources and diagnostics

```python
from a2a_schema_contract.resources import read_schema, schema_resource

schema = read_schema("catalog")  # independent tree
resource = schema_resource("catalog")  # importlib.resources Traversable
```

Seven schemas retain upstream bytes, license, notice and source pin
`a5c007510faa3fce85190f2e76e402faf0e897ad`. Installed usage needs no checkout.
`ContractError.code`, `.origin` and optional frozen `.detail` omit payloads,
schemas, URLs and vendor messages. Local diagnostics map to the draft's existing
wire codes; they do not extend the protocol error vocabulary.

## Contribution and verification

```sh
uv sync --locked --all-extras --python 3.12
uv run ruff format --check src tests scripts
uv run ruff check src tests scripts
uv run mypy
uv run pytest --cov --cov-report=term-missing
uv run coverage json --include='*/core/*' --fail-under=100 -o reports/core-coverage.json
uv run python scripts/check_package.py
uv run python scripts/check_matrix.py
```

One committed uv lock, Ruff, strict mypy and pytest with explicit async mode and
timeouts are the baseline. Coverage requires 90% combined statement/branch coverage
overall and 100% for the domain core.
New behavior needs meaningful successful/rejected, mutation, lifecycle and artifact
tests. Package checks build wheel/sdist, reproduce the wheel from sdist, and run
noneditable core/server-extra consumers outside the checkout. CI includes Linux
3.11–3.14 and macOS/Windows smoke profiles; configured jobs are not assumed passed.

See [architecture](../docs/python-architecture.md),
[foundation evidence](../docs/python-foundation-report.md) and [delivery plan](../PLAN.md).
