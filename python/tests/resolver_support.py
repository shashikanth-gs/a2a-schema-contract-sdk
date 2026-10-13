"""Real verified loopback TLS with explicit test-only host/address admission."""

import asyncio
import ssl
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class TLSPeer:
    port: int = 0
    routes: dict[str, bytes] = field(default_factory=dict)
    requests: list[tuple[str, dict[str, str]]] = field(default_factory=list)
    sni: list[str | None] = field(default_factory=list)
    active: set[asyncio.Task[object]] = field(default_factory=set)
    writers: set[asyncio.StreamWriter] = field(default_factory=set)
    entered: asyncio.Event = field(default_factory=asyncio.Event)

    def url(self, path: str, host: str = "a.example.test") -> str:
        return f"https://{host}:{self.port}{path}"

    @property
    def origin(self) -> str:
        return f"https://a.example.test:{self.port}"

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        assert task is not None
        self.active.add(task)
        self.writers.add(writer)
        try:
            head = await reader.readuntil(b"\r\n\r\n")
            lines = head.decode("ascii").split("\r\n")
            path = lines[0].split(" ")[1]
            headers = dict(line.lower().split(": ", 1) for line in lines[1:] if line)
            self.requests.append((path, headers))
            self.entered.set()
            response = self.routes.get(path)
            if response is not None:
                writer.write(response)
                await writer.drain()
            if response is None or response.endswith(b"STALL"):
                await reader.read()
        except (OSError, asyncio.IncompleteReadError):
            pass
        finally:
            writer.close()
            with suppress(OSError, ssl.SSLError):
                await writer.wait_closed()
            self.active.discard(task)
            self.writers.discard(writer)


def response(
    body: bytes,
    media: str = "application/schema+json",
    *,
    status: int = 200,
    headers: tuple[tuple[str, str], ...] = (),
) -> bytes:
    pairs = [("Content-Type", media), ("Content-Length", str(len(body))), *headers]
    return (
        f"HTTP/1.1 {status} Test\r\n"
        + "".join(f"{key}: {value}\r\n" for key, value in pairs)
        + "\r\n"
    ).encode() + body


def trust() -> ssl.SSLContext:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_verify_locations(cafile=str(Path(__file__).parent / "fixtures/tls/cert.pem"))
    return context


async def lookup(hostname: str) -> tuple[str, ...]:
    return ("127.0.0.1",)


@asynccontextmanager
async def peer() -> AsyncIterator[TLSPeer]:
    value = TLSPeer()
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    path = Path(__file__).parent / "fixtures/tls"
    context.load_cert_chain(path / "cert.pem", path / "key.pem")
    context.set_servername_callback(lambda ssl_object, name, ctx: value.sni.append(name))
    server = await asyncio.start_server(
        value.handle, "127.0.0.1", 0, ssl=context, ssl_shutdown_timeout=0.1
    )
    value.port = server.sockets[0].getsockname()[1]
    try:
        yield value
    finally:
        server.close()
        await server.wait_closed()
        for writer in tuple(value.writers):
            writer.close()
        tasks = tuple(value.active)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


def catalog(schema: object, *, uri: bool = True) -> dict[str, object]:
    descriptor = {
        "dialect": "https://json-schema.org/draft/2020-12/schema",
        "mediaType": "application/schema+json",
        "uri" if uri else "inline": schema,
    }
    return {
        "contracts": [
            {
                "id": "urn:example:contract:echo:1",
                "input": {
                    "presence": "required",
                    "representations": [
                        {"id": "json", "mediaType": "application/json", "schema": descriptor}
                    ],
                },
                "output": {"presence": "none"},
            }
        ]
    }
