"""Installed, revision-pinned draft schemas; explicit offline resource access."""

import json
from importlib.resources import files
from importlib.resources.abc import Traversable
from typing import Literal, TypeAlias, cast

from a2a_schema_contract.core import JsonValue

SchemaName: TypeAlias = Literal[
    "catalog",
    "common",
    "error-detail",
    "extension-params",
    "invocation-metadata",
    "part-metadata",
    "result-metadata",
]
SCHEMA_NAMES: tuple[SchemaName, ...] = (
    "catalog",
    "common",
    "error-detail",
    "extension-params",
    "invocation-metadata",
    "part-metadata",
    "result-metadata",
)


def schema_resource(name: SchemaName) -> Traversable:
    """Works for installed wheels and zip importers; caller explicitly reads resources."""
    if name not in SCHEMA_NAMES:
        raise ValueError("Unknown extension schema resource.")
    return files(__package__).joinpath("schema", f"{name}.schema.json")


def read_schema(name: SchemaName) -> dict[str, JsonValue]:
    """Return an independent tree; packaged inputs are verified at build/test time."""
    return cast("dict[str, JsonValue]", json.loads(schema_resource(name).read_text("utf-8")))
