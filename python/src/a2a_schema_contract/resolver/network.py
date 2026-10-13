"""Fresh TLS connections to one approved IP; h11 provides HTTP/1.1 framing only."""

import asyncio
import contextlib
import ipaddress
import json
import socket
import ssl
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import h11

from a2a_schema_contract.core import ContractError, ErrorContext
from a2a_schema_contract.operations.process import encode, exchange

from .policy import ResourceURL, public_address

Lookup = Callable[[str], Awaitable[tuple[str, ...]]]


async def system_lookup(hostname: str) -> tuple[str, ...]:
    raw = await exchange(
        encode({"operation": "dns", "arguments": {"hostname": hostname}}), dns=True
    )
    packet = json.loads(raw)
    if "value" not in packet:
        raise ContractError("SCHEMA_UNAVAILABLE")
    return tuple(cast("list[str]", packet["value"]))


def default_tls() -> ssl.SSLContext:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    paths = ssl.get_default_verify_paths()
    cafile = paths.openssl_cafile if Path(paths.openssl_cafile).is_file() else None
    capath = paths.openssl_capath if Path(paths.openssl_capath).is_dir() else None
    if cafile or capath:
        context.load_verify_locations(cafile=cafile, capath=capath)
    elif hasattr(ssl, "enum_certificates"):
        # Public Windows trust stores, without SSL_CERT_FILE/SSL_CERT_DIR.
        for store in ("CA", "ROOT"):
            for certificate, encoding, trust in ssl.enum_certificates(store):
                if encoding == "x509_asn" and (trust is True or "1.3.6.1.5.5.7.3.1" in trust):
                    context.load_verify_locations(cadata=ssl.DER_cert_to_PEM_cert(certificate))
    return context


@dataclass(frozen=True, slots=True)
class Response:
    status: int
    headers: Mapping[str, str]
    body: bytes


async def retrieve(
    url: ResourceURL,
    *,
    lookup: Lookup,
    allowed_origins: frozenset[str] | None,
    allowed_addresses: Mapping[str, tuple[str, ...]],
    authorization: str | None,
    tls: ssl.SSLContext,
    maximum: int,
    context: ErrorContext,
) -> Response:
    if allowed_origins is not None and url.origin not in allowed_origins:
        raise ContractError("RESOLUTION_POLICY", context)
    try:
        literal = ipaddress.ip_address(url.hostname)
    except ValueError:
        try:
            addresses = await lookup(url.hostname)
        except ContractError as error:
            raise ContractError(error.code, context) from None
    else:
        addresses = (str(literal),)
    if type(addresses) is not tuple or not addresses or len(addresses) > 64:
        raise ContractError("RESOLUTION_POLICY", context)
    for address in addresses:
        if type(address) is not str or "%" in address:
            raise ContractError("RESOLUTION_POLICY", context)
        try:
            canonical = str(ipaddress.ip_address(address))
        except ValueError:
            raise ContractError("RESOLUTION_POLICY", context) from None
        if canonical != address or (
            not public_address(address) and address not in allowed_addresses.get(url.hostname, ())
        ):
            raise ContractError("RESOLUTION_POLICY", context)
    address = addresses[0]
    # Numeric host + explicit family prevent a second DNS lookup/fallback.
    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    reader, writer = await asyncio.open_connection(
        address,
        url.port,
        family=family,
        ssl=tls,
        server_hostname=url.hostname,
        ssl_handshake_timeout=10,
        ssl_shutdown_timeout=0.1,
        limit=32768,
    )
    try:
        peer = writer.get_extra_info("peername")
        if not peer or str(ipaddress.ip_address(peer[0])) != address:
            raise ContractError("RESOLUTION_POLICY", context)
        connection = h11.Connection(h11.CLIENT, max_incomplete_event_size=32768)
        headers = [
            (b"host", url.authority.encode("ascii")),
            (b"accept-encoding", b"identity"),
            (b"connection", b"close"),
        ]
        if authorization is not None:
            headers.append((b"authorization", authorization.encode("ascii")))
        wire = connection.send(
            h11.Request(method=b"GET", target=url.target.encode("ascii"), headers=headers)
        )
        assert wire is not None
        writer.write(wire)
        writer.write(connection.send(h11.EndOfMessage()) or b"")
        await writer.drain()
        status = 0
        received: dict[str, str] = {}
        body = bytearray()
        eof = False
        while True:
            event = connection.next_event()
            if event is h11.NEED_DATA:
                if eof:
                    raise ContractError("SCHEMA_UNAVAILABLE", context)
                block = await reader.read(16384)
                eof = not block
                connection.receive_data(block)
            elif isinstance(event, h11.InformationalResponse):
                raise ContractError("RESOLUTION_POLICY", context)
            elif isinstance(event, h11.Response):
                status = event.status_code
                if len(event.headers) > 64:
                    raise ContractError("RESOURCE_LIMIT", context)
                for name, value in event.headers:
                    key = name.decode("ascii").lower()
                    if key in received:
                        raise ContractError("RESOLUTION_POLICY", context)
                    received[key] = value.decode("ascii")
                if "transfer-encoding" in received and "content-length" in received:
                    raise ContractError("RESOLUTION_POLICY", context)
                if status in (301, 302, 303, 307, 308):
                    return Response(status, received, b"")
                if status != 200:
                    raise ContractError("SCHEMA_UNAVAILABLE", context)
                if received.get("content-encoding", "identity").lower() != "identity":
                    raise ContractError("RESOLUTION_POLICY", context)
                if int(received.get("content-length", "0")) > maximum:
                    raise ContractError("RESOURCE_LIMIT", context)
            elif isinstance(event, h11.Data):
                body.extend(event.data)
                if len(body) > maximum:
                    raise ContractError("RESOURCE_LIMIT", context)
            elif isinstance(event, h11.EndOfMessage):
                if event.headers:
                    raise ContractError("RESOLUTION_POLICY", context)
                return Response(status, received, bytes(body))
            else:
                raise ContractError("SCHEMA_UNAVAILABLE", context)
    finally:
        writer.close()
        with contextlib.suppress(OSError, ssl.SSLError):
            await writer.wait_closed()
