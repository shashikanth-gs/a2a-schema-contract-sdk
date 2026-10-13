"""Enforce dependency direction and installed source provenance."""

import ast
import hashlib
import json
import subprocess
import sys
from pathlib import Path

from a2a_schema_contract.resources import SCHEMA_NAMES, read_schema, schema_resource

PACKAGE = Path(__file__).parents[1] / "src" / "a2a_schema_contract"


def test_core_has_no_infrastructure_imports() -> None:
    for path in (PACKAGE / "core").glob("*.py"):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                modules = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                modules = [node.module or ""]
            else:
                continue
            assert not any(
                module.split(".")[0]
                in {
                    "a2a",
                    "httpx",
                    "jsonschema",
                    "referencing",
                    "langgraph",
                    "google",
                }
                for module in modules
            ), path
            assert not any(
                module.startswith(
                    (
                        "a2a_schema_contract.validation",
                        "a2a_schema_contract.adapters",
                        "a2a_schema_contract.resources",
                        "a2a_schema_contract.ports",
                        "a2a_schema_contract.client",
                        "a2a_schema_contract.server",
                        "a2a_schema_contract.resolver",
                        "a2a_schema_contract.operations",
                    )
                )
                for module in modules
            ), path
            if isinstance(node, ast.ImportFrom):
                assert node.level <= 1, path


def test_root_import_has_no_network_environment_or_sdk_side_effects() -> None:
    code = """
import os, socket, sys
before = dict(os.environ)
def forbidden(*args, **kwargs):
    raise AssertionError('network on import')
socket.socket.connect = forbidden
import a2a_schema_contract
assert dict(os.environ) == before
assert not any(n.split('.')[0] in {'a2a', 'httpx', 'google', 'langgraph', 'jsonschema'}
               for n in sys.modules)
"""
    subprocess.run([sys.executable, "-I", "-c", code], check=True, timeout=10)


def test_packaged_schema_provenance() -> None:
    manifest = json.loads((Path(__file__).parent / "fixtures" / "manifest.json").read_text())
    for name in SCHEMA_NAMES:
        resource = schema_resource(name)
        assert (
            hashlib.sha256(resource.read_bytes()).hexdigest()
            == manifest["files"][f"schema/{name}.schema.json"]
        )
        assert read_schema(name)["$schema"] == "https://json-schema.org/draft/2020-12/schema"


def test_resource_access_detached() -> None:
    first = read_schema("catalog")
    first["title"] = "changed"
    assert read_schema("catalog")["title"] != "changed"
