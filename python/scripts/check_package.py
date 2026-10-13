"""Build/rebuild and exercise noneditable installed wheel consumers outside the checkout."""

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(args: list[str], *, cwd: Path = ROOT) -> None:
    subprocess.run(args, cwd=cwd, check=True, timeout=120)


def main() -> None:
    # Hatchling's reproducible archive timestamp, deliberately stable across hosts/builds.
    os.environ["SOURCE_DATE_EPOCH"] = "1767225600"
    run(["uv", "build", "--clear"])
    wheels = list((ROOT / "dist").glob("*.whl"))
    sdists = list((ROOT / "dist").glob("*.tar.gz"))
    assert len(wheels) == len(sdists) == 1
    wheel, sdist = wheels[0], sdists[0]
    with zipfile.ZipFile(wheel) as archive:
        names = archive.namelist()
        assert "a2a_schema_contract/py.typed" in names
        assert len([n for n in names if n.endswith(".schema.json")]) == 7
        assert "a2a_schema_contract/resources/source.json" in names
        assert "a2a_schema_contract/resources/NOTICE" in names
        assert any(n.endswith("/licenses/LICENSE") for n in names)
        metadata = archive.read(next(n for n in names if n.endswith("/METADATA"))).decode()
        assert "License-Expression: Apache-2.0" in metadata
        assert "Requires-Python: <3.15,>=3.11" in metadata
        assert "Provides-Extra: a2a" in metadata
        assert not any("test" in n or ".env" in n or "uv.lock" in n for n in names)
    run(["uv", "build", str(sdist), "--wheel", "--out-dir", str(ROOT / "dist/rebuilt")])
    rebuilt = next((ROOT / "dist/rebuilt").glob("*.whl"))
    assert wheel.read_bytes() == rebuilt.read_bytes(), "sdist rebuild must reproduce the wheel"
    run([sys.executable, "-m", "twine", "check", "--strict", str(wheel), str(sdist)])
    smoke = """
import importlib.util, sys
from a2a_schema_contract import MISSING, ContractError
from a2a_schema_contract.resources import SCHEMA_NAMES, read_schema
from a2a_schema_contract.validation import validate_value
from a2a_schema_contract.catalog import parse_catalog
from a2a_schema_contract.discovery import describe_contracts
assert importlib.util.find_spec('a2a') is None
assert importlib.util.find_spec('pytest') is None
assert MISSING is not None
assert validate_value({'nested': None}, schema={'type': 'object'}) == {'nested': None}
try:
    validate_value(True, schema={'type':'integer'})
except ContractError as error:
    assert error.code == 'INSTANCE_INVALID'
else:
    raise AssertionError('coercion leaked into the artifact')
assert len(SCHEMA_NAMES) == 7
for name in SCHEMA_NAMES:
    assert read_schema(name)['$id']
assert 'a2a' not in sys.modules
catalog = parse_catalog({'contracts': [{'id': 'urn:example:1',
    'input': {'presence': 'none'}, 'output': {'presence': 'none'}}]})
assert describe_contracts(catalog).contracts[0].contract.id == 'urn:example:1'
"""
    with tempfile.TemporaryDirectory(prefix="schema-contract-wheel-") as directory:
        temporary = Path(directory)
        environment = temporary / "venv"
        run(["uv", "venv", str(environment), "--python", sys.executable], cwd=temporary)
        python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        run(["uv", "pip", "install", "--python", str(python), str(wheel)], cwd=temporary)
        run([str(python), "-I", "-c", smoke], cwd=temporary)
        run(["uv", "pip", "check", "--python", str(python)], cwd=temporary)
        run(["uv", "pip", "install", "--python", str(python), f"{wheel}[server]"], cwd=temporary)
        run(
            [
                str(python),
                "-I",
                "-c",
                """
from a2a_schema_contract.adapters.a2a import part_from_wire, part_to_wire
assert part_to_wire(part_from_wire({'data': None})) == {'data': None}
assert part_to_wire(part_from_wire({'text': ''})) == {'text': ''}
from a2a.server.routes import create_jsonrpc_routes
assert callable(create_jsonrpc_routes)
""",
            ],
            cwd=temporary,
        )
        for example in re.findall(r"```python\n(.*?)\n```", (ROOT / "README.md").read_text(), re.S):
            run([str(python), "-I", "-c", example], cwd=temporary)
        run(["uv", "pip", "install", "--python", str(python), "uvicorn==0.42.0"], cwd=temporary)
        demo = temporary / "inline_demo.py"
        demo.write_bytes((ROOT / "examples/inline_demo.py").read_bytes())
        run([str(python), "-I", str(demo)], cwd=temporary)
        tls_files = []
        for name in ("cert.pem", "key.pem"):
            destination = temporary / name
            destination.write_bytes((ROOT / "tests/fixtures/tls" / name).read_bytes())
            tls_files.append(str(destination))
        run([str(python), "-I", str(demo), *tls_files], cwd=temporary)
        benchmark = temporary / "benchmark_operations.py"
        benchmark.write_bytes((ROOT / "scripts/benchmark_operations.py").read_bytes())
        measured = subprocess.run(
            [str(python), "-I", str(benchmark), *tls_files],
            cwd=temporary,
            check=True,
            text=True,
            capture_output=True,
            timeout=120,
        )
        performance = json.loads(measured.stdout)
        assert performance["result"] == "PASS" and performance["cached_retrievals"] == 0
        assert performance["fresh_process_compile"]["max_ms"] < 2000
        assert performance["cold_pinned_https_prepare"]["max_ms"] < 2000
        assert performance["cached_pinned_https_prepare"]["max_ms"] < 2000
        run(["uv", "pip", "install", "--python", str(python), "mypy==2.4.0"], cwd=temporary)
        consumer = temporary / "typed_consumer.py"
        consumer.write_text("""
from typing import assert_type
from a2a_schema_contract import MISSING, ContractError, JsonValue, Missing
from a2a_schema_contract.core import ErrorContext
from a2a_schema_contract.ports import SchemaValidator, ValidationEngine
from a2a_schema_contract.validation import JsonSchemaEngine, validate_value
from a2a_schema_contract.adapters.a2a import part_from_wire, part_to_wire
from a2a_schema_contract.catalog import ContractCatalog, PreparedRepresentation
from a2a_schema_contract.core.models import PreparedSchema, Payload, Contract
from a2a_schema_contract.client import (
    ContractClient, PreparedInvocation, ContractResponse, ClientEvent,
)
from a2a_schema_contract.discovery import ContractDiscovery
from a2a_schema_contract.resolver import ContractResolver, ResolverLimits, CacheInfo
from a2a_schema_contract.operations import ValidationSession, ValidationOptions, Diagnostic
assert_type(MISSING, Missing)
engine: ValidationEngine = JsonSchemaEngine()
validator: SchemaValidator = engine.compile({'type': 'integer'})
assert_type(validator.validate(1), JsonValue)
assert_type(validate_value(1), JsonValue)
assert_type(part_to_wire(part_from_wire({'data': 1})), dict[str, JsonValue])
error = ContractError('INSTANCE_INVALID', ErrorContext(direction='input'))
async def check_resolver(resolver: ContractResolver, session: ValidationSession) -> None:
    assert_type(resolver.cache, CacheInfo)
    assert_type(await resolver.resolve_catalog({"contracts": []}), ContractCatalog)
    assert_type(
        await session.run("compile", {"entry": "urn:example:1", "documents": []}), JsonValue
    )
async def check_client(client: ContractClient) -> None:
    assert_type(client.catalog, ContractCatalog)
    assert_type(client.describe(), ContractDiscovery)
    assert_type(client.bind_skill('echo'), Contract)
    assert_type(client.catalog.schema('urn:example:1', 'input', 'json'), PreparedSchema | None)
    assert_type(client.catalog.select('urn:example:1', 'input', 'json'), PreparedRepresentation)
    prepared = client.prepare('urn:example:1', input={'text': 'hello'})
    assert_type(prepared, PreparedInvocation)
    result = await client.invoke(prepared)
    assert_type(result, ContractResponse)
    assert_type(result.payload, Payload | None)
    async for event in client.stream(prepared):
        assert_type(event, ClientEvent)
""")
        run([str(python), "-m", "mypy", "--strict", str(consumer)], cwd=temporary)
    report = {
        "result": "PASS",
        "python": sys.version.split()[0],
        "wheel": {"name": wheel.name, "sha256": hashlib.sha256(wheel.read_bytes()).hexdigest()},
        "sdist": {"name": sdist.name, "sha256": hashlib.sha256(sdist.read_bytes()).hexdigest()},
        "performance": performance,
        "checks": [
            "artifact-resources-license-types",
            "sdist-wheel-reproducibility",
            "strict-metadata",
            "isolated-core-no-a2a-or-dev",
            "isolated-server-extra",
            "installed-readme-examples",
            "installed-strict-public-types",
            "installed-core-catalog-discovery-without-a2a",
            "installed-real-http-sse-typed-discovery-demo",
            "installed-verified-pinned-https-native-resource-demo",
            "installed-worker-and-https-performance-baseline",
        ],
    }
    (ROOT / "reports").mkdir(exist_ok=True)
    (ROOT / "reports/package-check.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
