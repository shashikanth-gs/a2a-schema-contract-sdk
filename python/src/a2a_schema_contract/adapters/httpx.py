"""Public HTTPX bridge: borrowed-client ownership and pre-protobuf response admission."""

import asyncio
from collections.abc import AsyncIterator, Callable
from typing import cast

import httpx
from a2a.types import AgentCard, SendMessageResponse, StreamResponse, Task

from ..binding import guard_artifact, guard_container, reject
from ..catalog import parse_extension
from ..core import EXTENSION_URI, LIMITS, ContractError, ErrorContext, JsonValue, loads
from .wire import admit


def _envelope(raw: bytes, method: str, identifier: JsonValue) -> None:
    data = loads(raw, ErrorContext("remote"))
    if not isinstance(data, dict) or data.get("jsonrpc") != "2.0":
        reject()
    if data.get("id") != identifier or type(data.get("id")) is not type(identifier):
        reject()
    if ("result" in data) == ("error" in data):
        reject()
    if "error" in data:
        error = data["error"]
        if not isinstance(error, dict) or type(error.get("code")) is not int:
            reject()
        if not isinstance(error.get("message"), str):
            reject()
        return
    if method in ("GetTask", "CancelTask"):
        guard_container(admit(data["result"], Task))
        return
    model = StreamResponse if method == "SendStreamingMessage" else SendMessageResponse
    result = admit(data["result"], model)
    if len(result) != 1:
        reject()
    name, value = next(iter(result.items()))
    current = guard_container(value)
    if name == "artifactUpdate":
        guard_artifact(current.get("artifact"))


def _card(raw: bytes) -> None:
    card = admit(loads(raw, ErrorContext("remote")), AgentCard)
    capabilities = cast("dict[str, JsonValue]", card.get("capabilities", {}))
    extensions = cast("list[dict[str, JsonValue]]", capabilities.get("extensions", []))
    matches = [extension for extension in extensions if extension.get("uri") == EXTENSION_URI]
    if len(matches) != 1:
        reject()
    parse_extension(matches[0])


class _GuardStream(httpx.AsyncByteStream):
    def __init__(
        self,
        response: httpx.Response,
        method: str,
        identifier: JsonValue,
        release: Callable[[], None],
    ) -> None:
        self.response, self.method = response, method
        self.identifier = identifier
        self.release = release

    async def __aiter__(self) -> AsyncIterator[bytes]:
        total = 0
        pending = bytearray()
        frame = bytearray()
        count = 0
        streaming = "text/event-stream" in self.response.headers.get("content-type", "")
        if self.method == "SendStreamingMessage" and not streaming:
            reject()
        async for chunk in self.response.aiter_bytes():
            total += len(chunk)
            if total > LIMITS.bytes:
                raise ContractError("RESOURCE_LIMIT", ErrorContext("remote"))
            pending.extend(chunk)
            if not streaming:
                continue
            while b"\n" in pending:
                index = pending.index(b"\n") + 1
                line = bytes(pending[:index])
                del pending[:index]
                frame.extend(line)
                if line.rstrip(b"\r\n"):
                    continue
                try:
                    lines = bytes(frame).decode("utf-8", "strict").splitlines()
                except UnicodeError:
                    reject()
                values = [line[5:].removeprefix(" ") for line in lines if line.startswith("data:")]
                if values:
                    count += 1
                    if count > 128:
                        raise ContractError("RESOURCE_LIMIT", ErrorContext("remote"))
                    _envelope("\n".join(values).encode(), self.method, self.identifier)
                yield bytes(frame)
                frame.clear()
        if streaming:
            if pending or frame or not count:
                reject()
        elif self.response.is_success:
            if self.method == "card":
                _card(bytes(pending))
            else:
                _envelope(bytes(pending), self.method, self.identifier)
            yield bytes(pending)
        else:
            # Let the official transport report the HTTP status without reading an unbounded body.
            yield bytes(pending)

    async def aclose(self) -> None:
        try:
            await self.response.aclose()
        finally:
            self.release()


class BorrowedTransport(httpx.AsyncBaseTransport):
    """Closing this bridge never closes the application-owned HTTPX client."""

    def __init__(self, client: httpx.AsyncClient) -> None:
        self.client = client
        self.responses: set[httpx.Response] = set()
        self.pending: set[asyncio.Task[object]] = set()
        self.closed = False

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if self.closed:
            raise ContractError("VALIDATION_ABORTED")
        body = await request.aread()
        method = "card"
        identifier: JsonValue = None
        if request.method == "POST":
            data = loads(body)
            if not isinstance(data, dict) or not isinstance(data.get("method"), str):
                reject()
            method = cast("str", data["method"])
            identifier = data.get("id")
        forwarded = self.client.build_request(
            request.method,
            request.url,
            content=body,
            headers=request.headers,
            extensions=request.extensions,
        )
        active = asyncio.current_task()
        assert active is not None
        self.pending.add(active)
        try:
            response = await self.client.send(forwarded, stream=True, follow_redirects=False)
        finally:
            self.pending.discard(active)
        if self.closed:
            await response.aclose()
            raise ContractError("VALIDATION_ABORTED")
        self.responses.add(response)
        return httpx.Response(
            response.status_code,
            headers=response.headers,
            request=request,
            stream=_GuardStream(
                response, method, identifier, lambda: self.responses.discard(response)
            ),
            extensions=response.extensions,
        )

    async def aclose(self) -> None:
        self.closed = True
        for task in tuple(self.pending):
            if task is not asyncio.current_task():
                task.cancel()
        for response in tuple(self.responses):
            await response.aclose()
            self.responses.discard(response)
