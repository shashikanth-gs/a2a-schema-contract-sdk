"""Native JSON Schema identities, inspected locations and graph budgets."""

import json

import pytest

from a2a_schema_contract.core import ContractError
from a2a_schema_contract.resolver import ResolverLimits

from .resolver_support import catalog, peer, response
from .test_resolver_tls import ID, resolver


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "schema,code",
    [
        ({"$ref": "#/default", "default": {"type": "integer"}}, "SCHEMA_INVALID"),
        ({"$ref": "#/$defs/missing"}, "SCHEMA_INVALID"),
        ({"$ref": "#%2F$defs/x", "$defs": {"x": True}}, "SCHEMA_INVALID"),
        ({"$id": "https://example.test/v1.json#anchor"}, "SCHEMA_INVALID"),
        (
            {"$defs": {"x": {"$id": "urn:duplicate:1"}, "y": {"$id": "urn:duplicate:1"}}},
            "SCHEMA_INVALID",
        ),
        ({"$defs": {"x": {"$anchor": "dup"}, "y": {"$anchor": "dup"}}}, "SCHEMA_INVALID"),
        ({"$dynamicRef": "https://example.test/v1.json#anchor"}, "SCHEMA_UNAVAILABLE"),
        ({"$ref": "http://example.test/v1.json"}, "RESOLUTION_POLICY"),
        ({"$ref": "https://user:pass@example.test/v1.json"}, "SCHEMA_INVALID"),
        ({"$ref": "#/foo/%FF"}, "SCHEMA_INVALID"),
        ({"$ref": "relative.json"}, "SCHEMA_INVALID"),
        ({"$id": "relative.json"}, "SCHEMA_INVALID"),
        ({"$id": "https://example.test/v1.json", "unknownAssertion": True}, "UNSUPPORTED_KEYWORD"),
    ],
)
async def test_inline_graph_rejects_uninspected_or_unsupported_targets(
    schema: object, code: str
) -> None:
    async with peer() as server, resolver(server) as service:
        with pytest.raises(ContractError, match=code):
            await service.resolve_catalog(catalog(schema, uri=False))
        assert not server.requests


@pytest.mark.asyncio
@pytest.mark.parametrize("fragment", ["#choice", "#/$defs/choice", "#/$defs/cho%69ce"])
async def test_entry_fragments_and_embedded_relative_resource(fragment: str) -> None:
    async with peer() as server:
        uri = server.url("/schemas/v1/root.json")
        schema = {
            "$id": uri,
            "$defs": {
                "choice": {"$anchor": "choice", "type": "integer"},
                "sub": {"$id": "sub.json", "type": "string"},
            },
        }
        server.routes["/schemas/v1/root.json"] = response(json.dumps(schema).encode())
        async with resolver(server) as service:
            prepared = await service.resolve_catalog(catalog(uri + fragment))
            assert prepared.select(ID, "input", "json").validate(3) == 3
            with pytest.raises(ContractError, match="INSTANCE_INVALID"):
                prepared.select(ID, "input", "json").validate("bad")
        assert len(server.requests) == 1


@pytest.mark.asyncio
async def test_local_recursion_native_and_cross_document_cycle_refused() -> None:
    async with peer() as server:
        local = {"type": "object", "properties": {"child": {"$ref": "#"}}}
        async with resolver(server) as service:
            prepared = await service.resolve_catalog(catalog(local, uri=False))
            assert prepared.select(ID, "input", "json").validate({"child": {}}) == {"child": {}}
        root, child = server.url("/root/v1.json"), server.url("/child/v1.json")
        server.routes["/root/v1.json"] = response(json.dumps({"$ref": child}).encode())
        server.routes["/child/v1.json"] = response(json.dumps({"$ref": root}).encode())
        async with resolver(server) as service:
            with pytest.raises(ContractError, match="REFERENCE_CYCLE"):
                await service.resolve_catalog(catalog(root))
        assert len(server.requests) == 2


@pytest.mark.asyncio
async def test_diamond_acquisition_once_and_duplicate_document_identity() -> None:
    async with peer() as server:
        root = server.url("/root/v1.json")
        left, right, leaf = (server.url(f"/{name}/v1.json") for name in ("left", "right", "leaf"))
        server.routes["/root/v1.json"] = response(
            json.dumps({"allOf": [{"$ref": left}, {"$ref": right}]}).encode()
        )
        for name in ("left", "right"):
            server.routes[f"/{name}/v1.json"] = response(json.dumps({"$ref": leaf}).encode())
        server.routes["/leaf/v1.json"] = response(b'{"type":"integer"}')
        async with resolver(server) as service:
            prepared = await service.resolve_catalog(catalog(root))
            assert prepared.select(ID, "input", "json").validate(1) == 1
        assert len(server.requests) == 4
        shared = {"$id": "urn:identity:shared:1", "type": "integer"}
        for name in ("left", "right"):
            server.routes[f"/{name}/v1.json"] = response(json.dumps(shared).encode())
        async with resolver(server) as service:
            with pytest.raises(ContractError, match="SCHEMA_INVALID"):
                await service.resolve_catalog(catalog(root))


@pytest.mark.asyncio
@pytest.mark.parametrize("limit", ["documents", "references", "schemas", "reference_depth"])
async def test_graph_limits(limit: str) -> None:
    async with peer() as server:
        root, child, leaf = (server.url(f"/{name}/v1.json") for name in ("root", "child", "leaf"))
        server.routes["/root/v1.json"] = response(
            json.dumps({"$ref": child, "allOf": [{"$ref": child}]}).encode()
        )
        server.routes["/child/v1.json"] = response(json.dumps({"$ref": leaf}).encode())
        server.routes["/leaf/v1.json"] = response(b"true")
        values = {limit: 1}
        async with resolver(server, limits=ResolverLimits(**values)) as service:
            with pytest.raises(ContractError, match="RESOURCE_LIMIT"):
                await service.resolve_catalog(catalog(root))


@pytest.mark.asyncio
async def test_cross_document_pattern_pointer_projection_is_private() -> None:
    async with peer() as server:
        root, child = server.url("/root/v1.json"), server.url("/child/v1.json")
        child_schema = {"patternProperties": {"^A$": {"type": "integer"}}}
        server.routes["/root/v1.json"] = response(
            json.dumps({"$ref": child + "#/patternProperties/^A$"}).encode()
        )
        server.routes["/child/v1.json"] = response(json.dumps(child_schema).encode())
        async with resolver(server) as service:
            prepared = await service.resolve_catalog(catalog(root))
            view = prepared.schema(ID, "input", "json")
            assert view is not None and view.documents[1].value == child_schema
            selected = prepared.select(ID, "input", "json")
            assert selected.validate(5) == 5
            with pytest.raises(ContractError, match="INSTANCE_INVALID"):
                selected.validate("bad")


@pytest.mark.asyncio
async def test_schema_uri_identity_normalizes_without_changing_public_documents() -> None:
    async with peer() as server:
        base = f"https://A.EXAMPLE.test:{server.port}/schemas/v1/root.json"
        original = {"$id": base, "$ref": "./%2e/child.json"}
        server.routes["/schemas/v1/child.json"] = response(b'{"type":"integer"}')
        async with resolver(server) as service:
            prepared = await service.resolve_catalog(catalog(original, uri=False))
            view = prepared.schema(ID, "input", "json")
            assert view is not None and view.documents[0].value == original
            assert prepared.select(ID, "input", "json").validate(1) == 1
        assert len(server.requests) == 1


@pytest.mark.asyncio
async def test_empty_fragment_resource_id_is_native_and_kept_original() -> None:
    async with peer() as server, resolver(server) as service:
        schema = {"$id": "#", "$defs": {"value": {"type": "integer"}}, "$ref": "#/$defs/value"}
        prepared = await service.resolve_catalog(catalog(schema, uri=False))
        assert prepared.select(ID, "input", "json").validate(2) == 2
        view = prepared.schema(ID, "input", "json")
        assert view is not None and view.documents[0].value == schema
