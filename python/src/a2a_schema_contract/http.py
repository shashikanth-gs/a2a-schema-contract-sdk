"""Optional ASGI mounting through the official A2A 1.0 JSON-RPC route factory."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import cast

from a2a.server.context import ServerCallContext
from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes
from a2a.server.routes.common import DefaultServerCallContextBuilder, ServerCallContextBuilder
from a2a.types import CancelTaskRequest, GetTaskRequest, SendMessageRequest
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .adapters.wire import admit
from .binding import guard_request, reject
from .core import EXTENSION_URI, LIMITS, ContractError, ErrorContext, JsonValue, loads
from .server import TRUSTED_TENANT, ContractServer


class _TrustedContext(ServerCallContextBuilder):
    def __init__(self, delegate: ServerCallContextBuilder) -> None:
        self.delegate = delegate

    def build(self, request: Request) -> ServerCallContext:
        context = self.delegate.build(request)
        context.state[TRUSTED_TENANT] = context.tenant
        return context


class _Admission:
    def __init__(self, app: ASGIApp, path: str) -> None:
        self.app, self.path = app, path

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["path"] != self.path or scope["method"] != "POST":
            await self.app(scope, receive, send)
            return
        body = bytearray()
        identifier: JsonValue = None
        error_code = -32602
        try:
            while True:
                event = await receive()
                if event["type"] == "http.disconnect":
                    return
                body.extend(event.get("body", b""))
                if len(body) > LIMITS.bytes:
                    raise ContractError("RESOURCE_LIMIT", ErrorContext("remote"))
                if not event.get("more_body", False):
                    break
            data = loads(bytes(body), ErrorContext("remote"))
            if not isinstance(data, dict) or data.keys() - {"jsonrpc", "id", "method", "params"}:
                reject()
            if data.get("jsonrpc") != "2.0" or type(data.get("id")) not in (str, int):
                reject()
            identifier = data["id"]
            method = data.get("method")
            params = data.get("params")
            if method in ("SendMessage", "SendStreamingMessage"):
                admit(params, SendMessageRequest)
                guard_request(params)
            elif method == "GetTask":
                value = admit(params, GetTaskRequest)
                if not value.get("id"):
                    reject()
            elif method == "CancelTask":
                value = admit(params, CancelTaskRequest)
                if not value.get("id"):
                    reject()
            else:
                error_code = -32601
                reject()
        except ContractError:
            response = JSONResponse(
                {
                    "jsonrpc": "2.0",
                    "id": identifier,
                    "error": {"code": error_code, "message": "Schema Contract request rejected."},
                }
            )
            await response(scope, receive, send)
            return
        consumed = False

        async def replay() -> Message:
            nonlocal consumed
            if consumed:
                return await receive()
            consumed = True
            return {"type": "http.request", "body": bytes(body), "more_body": False}

        activated = any(
            EXTENSION_URI.encode() in [item.strip() for item in value.split(b",")]
            for name, value in scope.get("headers", [])
            if name.lower() == b"a2a-extensions"
        )

        async def respond(message: Message) -> None:
            if message["type"] == "http.response.start":
                copied = dict(message)
                output_headers = list(message.get("headers", []))
                output_headers.append((b"a2a-version", b"1.0"))
                if activated:
                    output_headers.append((b"a2a-extensions", EXTENSION_URI.encode()))
                copied["headers"] = output_headers
                await send(cast("Message", copied))
            else:
                await send(message)

        await self.app(scope, replay, respond)


def create_app(
    server: ContractServer,
    *,
    rpc_path: str = "/a2a",
    context_builder: ServerCallContextBuilder | None = None,
) -> ASGIApp:
    """Mount the guarded official routes; lifespan shutdown closes owned server state.

    Authenticate before these routes. A custom builder supplies the trusted tenant
    from host authentication; caller JSON is never tenant selection authority.
    """
    if not rpc_path.startswith("/"):
        raise ValueError("RPC path must be absolute.")

    @asynccontextmanager
    async def lifespan(app: Starlette) -> AsyncIterator[None]:
        try:
            yield
        finally:
            await server.close()

    routes = create_jsonrpc_routes(
        server.handler,
        rpc_path,
        context_builder=_TrustedContext(context_builder or DefaultServerCallContextBuilder()),
    )
    routes.extend(create_agent_card_routes(server.card))
    return _Admission(Starlette(routes=routes, lifespan=lifespan), rpc_path)
