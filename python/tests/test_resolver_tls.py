"""Resolver tests exercise actual TLS/HTTP framing, not a mocked fetch shortcut."""

import asyncio
import base64
import hashlib
import json
from dataclasses import FrozenInstanceError

import pytest

from a2a_schema_contract.core import ContractError
from a2a_schema_contract.resolver import ContractResolver, ResolverLimits

from .resolver_support import TLSPeer, catalog, lookup, peer, response, trust

ID = "urn:example:contract:echo:1"


def resolver(
    server: TLSPeer,
    *,
    allowed_origins: tuple[str, ...] | None = None,
    authorization: dict[str, str] | None = None,
    immutable_resources: tuple[str, ...] = (),
    resource_integrity: dict[str, object] | None = None,
    limits: ResolverLimits | None = None,
) -> ContractResolver:
    return ContractResolver(
        lookup=lookup,
        tls=trust(),
        allowed_origins=allowed_origins,
        authorization=authorization,
        immutable_resources=immutable_resources,
        resource_integrity=resource_integrity,
        limits=limits if limits is not None else ResolverLimits(),
        allowed_addresses={"a.example.test": ("127.0.0.1",), "b.example.test": ("127.0.0.1",)},
    )


def digest(body: bytes, algorithm: str = "sha-256") -> dict[str, str]:
    return {
        "algorithm": algorithm,
        "value": base64.b64encode(hashlib.new(algorithm.replace("-", ""), body).digest()).decode(),
    }


@pytest.mark.asyncio
async def test_native_graph_immutable_inspection_and_offline_validation() -> None:
    async with peer() as server:
        uri = server.url("/schemas/v1/root.json")
        child = {
            "$id": server.url("/schemas/v1/child.json"),
            "$defs": {"a/b~c": {"type": "string", "pattern": "^[A-Z]+$"}},
        }
        root = {"$ref": "child.json#/$defs/a~1b~0c"}
        server.routes["/schemas/v1/root.json"] = response(json.dumps(root).encode())
        server.routes["/schemas/v1/child.json"] = response(json.dumps(child).encode())
        async with resolver(server) as service:
            prepared = await service.resolve_catalog(catalog(uri))
            view = prepared.schema(ID, "input", "json")
            assert view is not None and view.entry == uri and len(view.documents) == 2
            assert view.descriptor.value == {
                "dialect": "https://json-schema.org/draft/2020-12/schema",
                "mediaType": "application/schema+json",
                "uri": uri,
            }
            copy = view.documents[0].value
            assert isinstance(copy, dict)
            copy["$ref"] = "https://secret.test/changed"
            assert view.documents[0].value == root
            with pytest.raises(FrozenInstanceError):
                view.entry = "other"  # type: ignore[misc]
            service.clear_cache()
            selected = prepared.select(ID, "input", "json")
            assert selected.validate("ABC") == "ABC"
            with pytest.raises(ContractError, match="INSTANCE_INVALID"):
                selected.validate("ABC\n")
        # Resolver closure cannot revoke an immutable prepared view.
        assert prepared.select(ID, "input", "json").validate("Z") == "Z"
        assert len(server.requests) == 2
        assert server.sni == ["a.example.test", "a.example.test"]
        assert all(
            h["host"] == f"a.example.test:{server.port}"
            and h["accept-encoding"] == "identity"
            and "cookie" not in h
            for _, h in server.requests
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("algorithm", ["sha-256", "sha-512"])
async def test_pinned_catalog_schema_cache_and_partition(algorithm: str) -> None:
    async with peer() as server:
        body = b'{"type":"integer"}'
        uri = server.url("/schema/v1.json")
        raw = catalog(uri)
        catalog_body = json.dumps(raw).encode()
        server.routes["/schema/v1.json"] = response(body)
        server.routes["/catalog/v1.json"] = response(catalog_body, "application/json")
        params = {
            "catalog": {
                "uri": server.url("/catalog/v1.json"),
                "mediaType": "application/json",
                "integrity": digest(catalog_body, algorithm),
            }
        }
        async with resolver(
            server,
            resource_integrity={uri: digest(body, algorithm)},
            authorization={server.origin: "Bearer identity-A"},
        ) as service:
            first = await service.resolve_extension_params(params)
            count = len(server.requests)
            second = await service.resolve_extension_params(params)
            assert len(server.requests) == count == 2
            assert service.cache.entries == 2
            assert service.cache.bytes == len(body) + len(catalog_body)
            service.clear_cache()
            assert service.cache.entries == service.cache.bytes == 0
            assert first.select(ID, "input", "json").validate(3) == 3
            assert second.schema(ID, "input", "json") == first.schema(ID, "input", "json")
        async with resolver(
            server,
            resource_integrity={uri: digest(body, algorithm)},
            authorization={server.origin: "Bearer identity-B"},
        ) as other:
            await other.resolve_extension_params(params)
        assert len(server.requests) == 4
        assert server.requests[0][1]["authorization"] == "bearer identity-a"
        assert server.requests[-1][1]["authorization"] == "bearer identity-b"


@pytest.mark.asyncio
async def test_mutable_documents_are_not_reused_across_preparations() -> None:
    async with peer() as server:
        uri = server.url("/schema/v1.json")
        server.routes["/schema/v1.json"] = response(b'{"type":"integer"}')
        async with resolver(server) as service:
            old = await service.resolve_catalog(catalog(uri))
            server.routes["/schema/v1.json"] = response(b'{"type":"string"}')
            new = await service.resolve_catalog(catalog(uri))
            assert service.cache.entries == 0
            assert old.select(ID, "input", "json").validate(1) == 1
            assert new.select(ID, "input", "json").validate("one") == "one"
        assert len(server.requests) == 2


@pytest.mark.asyncio
async def test_catalog_requires_pin_or_exact_immutable_promise() -> None:
    async with peer() as server:
        uri = server.url("/catalog/v1.json")
        server.routes["/catalog/v1.json"] = response(
            json.dumps(catalog(True, uri=False)).encode(), "application/json"
        )
        async with resolver(server) as service:
            with pytest.raises(ContractError, match="RESOLUTION_POLICY"):
                await service.resolve_extension_params(
                    {"catalog": {"uri": uri, "mediaType": "application/json"}}
                )
            assert not server.requests
        async with resolver(server, immutable_resources=(uri,)) as service:
            await service.resolve_extension_params(
                {"catalog": {"uri": uri, "mediaType": "application/json"}}
            )
            await service.resolve_extension_params(
                {"catalog": {"uri": uri, "mediaType": "application/json"}}
            )
            assert len(server.requests) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body,headers,code",
    [
        (b'{"type":"integer"}', (("Content-Encoding", "gzip"),), "RESOLUTION_POLICY"),
        (b"\xff", (), "INVALID_STRUCTURE"),
        (b'{"type":"integer","type":"string"}', (), "INVALID_STRUCTURE"),
        (b'{"type": "integer"}', (("Content-Type", "application/json"),), "RESOLUTION_POLICY"),
    ],
)
async def test_original_bytes_and_headers_refused(
    body: bytes, headers: tuple[tuple[str, str], ...], code: str
) -> None:
    async with peer() as server:
        server.routes["/schema/v1.json"] = response(body, headers=headers)
        async with resolver(server) as service:
            with pytest.raises(ContractError, match=code):
                await service.resolve_catalog(catalog(server.url("/schema/v1.json")))


@pytest.mark.asyncio
async def test_integrity_conflicts_and_transitive_independent_pin() -> None:
    async with peer() as server:
        root = server.url("/root/v1.json")
        child = server.url("/child/v1.json")
        root_body = json.dumps({"$ref": child}).encode()
        server.routes["/root/v1.json"] = response(root_body)
        server.routes["/child/v1.json"] = response(b'{"type":"integer"}')
        async with resolver(
            server, resource_integrity={root: digest(root_body), child: digest(b"true")}
        ) as service:
            with pytest.raises(ContractError, match="INTEGRITY_MISMATCH"):
                await service.resolve_catalog(catalog(root))
        value = catalog(root)
        rep = value["contracts"][0]["input"]["representations"][0]  # type: ignore[index]
        rep["schema"]["integrity"] = digest(b"false")
        async with resolver(server, resource_integrity={root: digest(root_body)}) as service:
            before = len(server.requests)
            with pytest.raises(ContractError, match="INTEGRITY_MISMATCH"):
                await service.resolve_catalog(value)
            assert len(server.requests) == before


@pytest.mark.asyncio
@pytest.mark.parametrize("cross_origin", [False, True])
async def test_redirect_authentication_and_final_base(cross_origin: bool) -> None:
    async with peer() as server:
        host = "b.example.test" if cross_origin else "a.example.test"
        server.routes["/original/v1.json"] = response(
            b"ignored", status=302, headers=(("Location", server.url("/redirected/v1.json", host)),)
        )
        server.routes["/redirected/v1.json"] = response(b'{"$ref":"child.json"}')
        server.routes["/redirected/child.json"] = response(b'{"type":"integer"}')
        async with resolver(server, authorization={server.origin: "Bearer original"}) as service:
            prepared = await service.resolve_catalog(catalog(server.url("/original/v1.json")))
            view = prepared.schema(ID, "input", "json")
            assert view is not None
            assert view.documents[0].uri == server.url("/redirected/v1.json", host)
            assert view.documents[0].aliases == (server.url("/original/v1.json"),)
            assert prepared.select(ID, "input", "json").validate(5) == 5
        assert "authorization" in server.requests[0][1]
        assert ("authorization" in server.requests[1][1]) is not cross_origin


@pytest.mark.asyncio
async def test_cross_origin_bounce_cannot_restore_authorization() -> None:
    async with peer() as server:
        server.routes["/first/v1.json"] = response(
            b"",
            status=302,
            headers=(("Location", server.url("/second/v1.json", "b.example.test")),),
        )
        server.routes["/second/v1.json"] = response(
            b"", status=302, headers=(("Location", server.url("/final/v1.json")),)
        )
        server.routes["/final/v1.json"] = response(b"true")
        async with resolver(
            server,
            authorization={
                server.origin: "Bearer original",
                server.url("", "b.example.test"): "Bearer other",
            },
        ) as service:
            await service.resolve_catalog(catalog(server.url("/first/v1.json")))
        assert "authorization" in server.requests[0][1]
        assert all("authorization" not in headers for _, headers in server.requests[1:])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "target,code",
    [
        ("http://example.test/v1.json", "RESOLUTION_POLICY"),
        ("/root/v1.json", "REFERENCE_CYCLE"),
        ("https://disallowed.test/v1.json", "RESOLUTION_POLICY"),
    ],
)
async def test_redirect_each_hop_admitted(target: str, code: str) -> None:
    async with peer() as server:
        server.routes["/root/v1.json"] = response(b"", status=302, headers=(("Location", target),))
        async with resolver(server, allowed_origins=(server.origin,)) as service:
            with pytest.raises(ContractError, match=code):
                await service.resolve_catalog(catalog(server.url("/root/v1.json")))
        assert len(server.requests) == 1


@pytest.mark.asyncio
async def test_dns_all_answers_checked_and_connection_bound_once() -> None:
    async with peer() as server:
        server.routes["/schema/v1.json"] = response(b"true")
        calls = 0

        async def changing(hostname: str) -> tuple[str, ...]:
            nonlocal calls
            calls += 1
            return ("127.0.0.1",) if calls == 1 else ("10.0.0.1",)

        async with ContractResolver(
            lookup=changing, tls=trust(), allowed_addresses={"a.example.test": ("127.0.0.1",)}
        ) as service:
            await service.resolve_catalog(catalog(server.url("/schema/v1.json")))
        assert calls == 1 and len(server.requests) == 1

        async def mixed(hostname: str) -> tuple[str, ...]:
            return ("127.0.0.1", "10.0.0.1")

        async with ContractResolver(
            lookup=mixed, tls=trust(), allowed_addresses={"a.example.test": ("127.0.0.1",)}
        ) as service:
            with pytest.raises(ContractError, match="RESOLUTION_POLICY"):
                await service.resolve_catalog(catalog(server.url("/schema/v1.json")))
        assert len(server.requests) == 1


@pytest.mark.asyncio
async def test_response_total_budget_cache_lru_and_disabled_cache() -> None:
    async with peer() as server:
        root, child = server.url("/root/v1.json"), server.url("/child/v1.json")
        root_body = json.dumps({"$ref": child}).encode()
        server.routes["/root/v1.json"] = response(root_body)
        server.routes["/child/v1.json"] = response(b"true")
        async with resolver(server, limits=ResolverLimits(total_bytes=len(root_body))) as service:
            with pytest.raises(ContractError, match="RESOURCE_LIMIT"):
                await service.resolve_catalog(catalog(root))
        async with resolver(server, limits=ResolverLimits(response_bytes=3)) as service:
            with pytest.raises(ContractError, match="RESOURCE_LIMIT"):
                await service.resolve_catalog(catalog(child))
        async with resolver(
            server, immutable_resources=(root, child), limits=ResolverLimits(cache_entries=1)
        ) as service:
            await service.resolve_catalog(catalog(root))
            assert service.cache.entries == 1 and service.cache.bytes == 4
        async with resolver(
            server, immutable_resources=(child,), limits=ResolverLimits(cache_entries=0)
        ) as service:
            await service.resolve_catalog(catalog(child))
            assert service.cache.entries == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["deadline", "cancel", "close"])
async def test_body_stall_owned_cleanup(action: str) -> None:
    async with peer() as server:
        server.routes["/stall/v1.json"] = (
            b"HTTP/1.1 200 OK\r\nContent-Type: application/schema+json\r\n"
            b"Content-Length: 500\r\n\r\nSTALL"
        )
        service = resolver(server, limits=ResolverLimits(deadline=0.08))
        job = asyncio.create_task(service.resolve_catalog(catalog(server.url("/stall/v1.json"))))
        await server.entered.wait()
        if action == "deadline":
            with pytest.raises(ContractError, match="RESOLUTION_TIMEOUT"):
                await job
        else:
            if action == "close":
                await service.close()
            else:
                job.cancel()
            with pytest.raises(asyncio.CancelledError):
                await job
        assert not service._jobs
        for _ in range(20):
            if not server.active:
                break
            await asyncio.sleep(0.005)
        assert not server.active
        await service.close()
