"""Shared immutable resources must not expand once per representation in IPC."""

import pytest

from a2a_schema_contract.catalog import ContractCatalog
from a2a_schema_contract.core import JSON_SCHEMA_DIALECT, ContractError, JsonValue
from a2a_schema_contract.core.models import JsonDocument, PreparedSchema, SchemaResource
from a2a_schema_contract.operations.process import encode
from a2a_schema_contract.operations.program import catalog_packet, load_catalog

ID = "urn:example:shared:1"


def many_views(*, unique: bool) -> ContractCatalog:
    source = JsonDocument(
        {
            "type": "integer",
            "$defs": {f"description{i}": {"description": "x" * 8000} for i in range(30)},
        }
    )

    def uri(index: int) -> str:
        return f"https://schema.example.test/v1/{index if unique else 0}.json"

    reps: list[JsonValue] = [
        {
            "id": f"rep{i}",
            "mediaType": "application/json",
            "schema": {
                "uri": uri(i),
                "mediaType": "application/schema+json",
                "dialect": JSON_SCHEMA_DIALECT,
            },
        }
        for i in range(64)
    ]
    catalog = ContractCatalog(
        {
            "contracts": [
                {
                    "id": ID,
                    "input": {"presence": "required", "representations": reps},
                    "output": {"presence": "none"},
                }
            ]
        }
    )
    prepared = []
    for index, rep in enumerate(catalog.contracts[0].input.representations):
        assert rep.schema is not None
        prepared.append(
            (
                ID,
                "input",
                rep.id,
                PreparedSchema(uri(index), rep.schema, (SchemaResource(uri(index), source),)),
            )
        )
    object.__setattr__(catalog, "_prepared", tuple(prepared))
    return catalog


def test_resource_pool_roundtrip_without_per_representation_expansion() -> None:
    catalog = many_views(unique=False)
    packet = catalog_packet(catalog)
    assert isinstance(packet["documents"], list) and len(packet["documents"]) == 1
    assert len(encode(packet)) < 300000
    decoded = load_catalog(packet)
    first = decoded.schema(ID, "input", "rep0")
    last = decoded.schema(ID, "input", "rep63")
    assert first is not None and last is not None
    assert first.documents[0] is last.documents[0]
    assert decoded.select(ID, "input", "rep63").validate(2) == 2
    assert first.descriptor.value == catalog.schema(ID, "input", "rep0").descriptor.value  # type: ignore[union-attr]


def test_budget_refuses_before_materializing_the_complete_program() -> None:
    with pytest.raises(ContractError, match="RESOURCE_LIMIT"):
        catalog_packet(many_views(unique=True))
