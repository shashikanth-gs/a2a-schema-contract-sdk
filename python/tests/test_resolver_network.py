"""Framing, TLS identity, DNS lifetime and resolver concurrency probes."""

import asyncio
import ssl

import pytest

from a2a_schema_contract.core import ContractError
from a2a_schema_contract.operations import process
from a2a_schema_contract.resolver import ContractResolver, ResolverLimits
from a2a_schema_contract.resolver.network import system_lookup

from .resolver_support import catalog, lookup, peer, response, trust
from .test_operations import track_spawns
from .test_resolver_tls import ID, resolver


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "wire,code",
    [
        (b"HTTP/1.1 404 Missing\r\nContent-Length: 0\r\n\r\n", "SCHEMA_UNAVAILABLE"),
        (b"HTTP/1.1 100 Continue\r\n\r\n", "RESOLUTION_POLICY"),
        (
            (
                b"HTTP/1.1 200 OK\r\nContent-Type: a"
                b"pplication/schema+json\r\nTransfer"
                b"-Encoding: chunked\r\nContent-Leng"
                b"th: 4\r\n\r\n4\r\ntrue\r\n0\r\n\r\n"
            ),
            "RESOLUTION_POLICY",
        ),
        (
            (
                b"HTTP/1.1 200 OK\r\nContent-Type: a"
                b"pplication/schema+json\r\nTransfer"
                b"-Encoding: chunked\r\n\r\n4\r\ntrue\r\n0"
                b"\r\nX-Trailer: secret\r\n\r\n"
            ),
            "RESOLUTION_POLICY",
        ),
        (
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 4\r\n\r\ntrue",
            "UNSUPPORTED_MEDIA_TYPE",
        ),
        (
            (
                b"HTTP/1.1 200 OK\r\nContent-Type: a"
                b"pplication/schema+json\r\nContent-"
                b"Length: 40\r\n\r\ntrue"
            ),
            "SCHEMA_UNAVAILABLE",
        ),
        (b"HTTP/1.1 302 Redirect\r\nContent-Length: 0\r\n\r\n", "SCHEMA_UNAVAILABLE"),
        (
            b"HTTP/1.1 302 Redirect\r\nLocation: /bad path\r\nContent-Length: 0\r\n\r\n",
            "RESOLUTION_POLICY",
        ),
    ],
)
async def test_framing_and_media_rejections(wire: bytes, code: str) -> None:
    async with peer() as server:
        server.routes["/root/v1.json"] = wire
        async with resolver(server) as service:
            with pytest.raises(ContractError, match=code):
                await service.resolve_catalog(catalog(server.url("/root/v1.json")))


@pytest.mark.asyncio
async def test_chunked_integrity_representation_bytes() -> None:
    from .test_resolver_tls import digest

    async with peer() as server:
        server.routes["/root/v1.json"] = (
            b"HTTP/1.1 200 OK\r\nContent-Type: a"
            b"pplication/schema+json; charset="
            b'"UTF-8"\r\nTransfer-Encoding: chun'
            b"ked\r\n\r\n2\r\ntr\r\n2\r\nue\r\n0\r\n\r\n"
        )
        uri = server.url("/root/v1.json")
        async with resolver(server, resource_integrity={uri: digest(b"true")}) as service:
            prepared = await service.resolve_catalog(catalog(uri))
            assert prepared.select(ID, "input", "json").validate(None) is None


@pytest.mark.asyncio
async def test_no_second_dns_call_and_no_shared_client_or_environment_proxy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with peer() as server:
        loop = asyncio.get_running_loop()

        async def forbidden(*args: object, **kwargs: object) -> object:
            raise AssertionError("A second resolver was used.")

        monkeypatch.setattr(loop, "getaddrinfo", forbidden)
        monkeypatch.setenv("HTTPS_PROXY", "http://secret:credential@127.0.0.1:1")
        server.routes["/root/v1.json"] = response(b"true")
        async with resolver(server) as service:
            await service.resolve_catalog(catalog(server.url("/root/v1.json")))
        assert len(server.requests) == 1


@pytest.mark.asyncio
async def test_tls_hostname_and_trust_never_bypassed() -> None:
    async with peer() as server:
        uri = server.url("/root/v1.json", "wrong.example.test")
        async with ContractResolver(
            lookup=lookup, tls=trust(), allowed_addresses={"wrong.example.test": ("127.0.0.1",)}
        ) as service:
            with pytest.raises(ContractError, match="SCHEMA_UNAVAILABLE"):
                await service.resolve_catalog(catalog(uri))
        async with ContractResolver(
            lookup=lookup,
            tls=ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT),
            allowed_addresses={"a.example.test": ("127.0.0.1",)},
        ) as service:
            with pytest.raises(ContractError, match="SCHEMA_UNAVAILABLE"):
                await service.resolve_catalog(catalog(server.url("/root/v1.json")))
        assert not server.requests


@pytest.mark.asyncio
async def test_default_dns_is_process_owned_and_reaped(monkeypatch: pytest.MonkeyPatch) -> None:
    children = track_spawns(monkeypatch)
    assert await system_lookup("localhost")
    assert len(children) == 1 and children[0].returncode == 0
    monkeypatch.setattr(process, "bootstrap", lambda: "import time; time.sleep(20)")
    async with ContractResolver(limits=ResolverLimits(deadline=0.08)) as service:
        with pytest.raises(ContractError, match="RESOLUTION_TIMEOUT"):
            await service.resolve_catalog(catalog("https://a.example.test/v1.json"))
    assert len(children) == 2 and all(child.returncode is not None for child in children)


@pytest.mark.asyncio
async def test_resolver_capacity_cancellation_and_closed_rejection() -> None:
    entered = asyncio.Event()
    stopped = asyncio.Event()

    async def held_lookup(hostname: str) -> tuple[str, ...]:
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()
        return ()

    service = ContractResolver(lookup=held_lookup, limits=ResolverLimits(concurrent=1))
    job = asyncio.create_task(service.resolve_catalog(catalog("https://a.example.test/v1.json")))
    await entered.wait()
    with pytest.raises(ContractError, match="RESOURCE_LIMIT"):
        await service.resolve_catalog(catalog("https://a.example.test/v1.json"))
    await service.close()
    with pytest.raises(asyncio.CancelledError):
        await job
    assert stopped.is_set() and not service._jobs
    with pytest.raises(ContractError, match="RESOLUTION_ABORTED"):
        await service.resolve_catalog(catalog(True, uri=False))


@pytest.mark.asyncio
async def test_redirect_body_discard_and_limit() -> None:
    async with peer() as server:
        server.routes["/root/v1.json"] = (
            b"HTTP/1.1 302 Redirect\r\nLocation:"
            b" /final/v1.json\r\nContent-Length:"
            b" 9999999\r\n\r\nSTALL"
        )
        server.routes["/final/v1.json"] = response(b"true")
        async with resolver(server) as service:
            await service.resolve_catalog(catalog(server.url("/root/v1.json")))
        async with resolver(server, limits=ResolverLimits(redirects=0)) as service:
            with pytest.raises(ContractError, match="RESOURCE_LIMIT"):
                await service.resolve_catalog(catalog(server.url("/root/v1.json")))


@pytest.mark.asyncio
async def test_header_stall_timeout() -> None:
    async with peer() as server, resolver(server, limits=ResolverLimits(deadline=0.05)) as service:
        with pytest.raises(ContractError, match="RESOLUTION_TIMEOUT"):
            await service.resolve_catalog(catalog(server.url("/no-response/v1.json")))


@pytest.mark.asyncio
async def test_response_bytes_without_content_length_and_chunk_limit() -> None:
    async with peer() as server:
        uri = server.url("/root/v1.json")
        server.routes["/root/v1.json"] = (
            b"HTTP/1.1 200 OK\r\nContent-Type: application/schema+json\r\n\r\ntrue"
        )
        async with resolver(server, limits=ResolverLimits(response_bytes=3)) as service:
            with pytest.raises(ContractError, match="RESOURCE_LIMIT"):
                await service.resolve_catalog(catalog(uri))
        server.routes["/root/v1.json"] = (
            b"HTTP/1.1 200 OK\r\nContent-Type: a"
            b"pplication/schema+json\r\nTransfer"
            b"-Encoding: chunked\r\n\r\n4\r\ntrue\r\n0"
            b"\r\n\r\n"
        )
        async with resolver(server, limits=ResolverLimits(response_bytes=3)) as service:
            with pytest.raises(ContractError, match="RESOURCE_LIMIT"):
                await service.resolve_catalog(catalog(uri))
