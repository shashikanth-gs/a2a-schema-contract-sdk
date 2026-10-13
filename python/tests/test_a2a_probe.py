"""Published SDK compatibility probes; no source snapshot imports or private hooks."""

import asyncio
import inspect
import json
from importlib.metadata import version

import httpx
import pytest
from a2a.client import ClientCallContext, ClientConfig, ClientFactory
from a2a.client.transports.jsonrpc import JsonRpcTransport
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.context import ServerCallContext
from a2a.server.events import EventQueue
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.routes import create_jsonrpc_routes
from a2a.types import AgentCard, Part, SendMessageRequest
from google.protobuf.json_format import MessageToDict, ParseDict, ParseError

from a2a_schema_contract.adapters.a2a import part_from_wire, part_to_wire
from a2a_schema_contract.core import EXTENSION_URI, ContractError


@pytest.mark.parametrize("value", [None, {}, [], True, False, 0, 1.25, "", {"nested": None}])
def test_published_data_carrier(value: object) -> None:
    part = part_from_wire({"data": value})
    assert part.WhichOneof("content") == "data"
    assert part_to_wire(part)["data"] == value


def test_empty_text_keeps_carrier() -> None:
    assert part_to_wire(part_from_wire({"text": ""})) == {"text": ""}


@pytest.mark.parametrize(
    "value",
    [
        {},
        {"text": "a", "data": {}},
        {"data": {}, "metadata": None},
        {"text": 1},
        {"data": {}, "filename": 1},
        {"url": "/relative"},
        {"raw": "a"},
        {"raw": "YR=="},
        {"text": "a", "unknown": True},
    ],
)
def test_raw_guard_before_proto(value: object) -> None:
    with pytest.raises(ContractError):
        part_from_wire(value)


def test_proto_conversion_requires_original_boundary_guard() -> None:
    # SDK alone drops a null non-oneof string field. Our guard rejects it first.
    assert MessageToDict(ParseDict({"text": "a", "filename": None}, Part())) == {"text": "a"}
    with pytest.raises(ContractError, match="INVALID_CARRIER"):
        part_from_wire({"text": "a", "filename": None})
    with pytest.raises(ParseError):
        ParseDict({"text": "a", "data": {}}, Part())


def test_public_hook_signatures() -> None:
    assert version("a2a-sdk") == "1.2.2"
    assert inspect.iscoroutinefunction(AgentExecutor.execute)
    assert inspect.iscoroutinefunction(AgentExecutor.cancel)
    assert inspect.iscoroutinefunction(EventQueue.enqueue_event)
    assert "agent_executor" in inspect.signature(DefaultRequestHandler).parameters
    assert "agent_card" in inspect.signature(DefaultRequestHandler).parameters
    assert "context_builder" in inspect.signature(create_jsonrpc_routes).parameters
    assert "enable_v0_3_compat" in inspect.signature(create_jsonrpc_routes).parameters
    assert "card" in inspect.signature(ClientFactory.create).parameters
    assert ClientConfig(streaming=False).streaming is False


def test_operation_metadata_and_activation_accessors() -> None:
    request = ParseDict(
        {
            "message": {"messageId": "m", "role": "ROLE_USER", "parts": [{"text": ""}]},
            "metadata": {EXTENSION_URI: {"contractId": "urn:example:1"}},
        },
        SendMessageRequest(),
    )
    context = RequestContext(
        ServerCallContext(requested_extensions={EXTENSION_URI}),
        request=request,
    )
    assert context.metadata == {EXTENSION_URI: {"contractId": "urn:example:1"}}
    assert context.requested_extensions == {EXTENSION_URI}
    assert context.message is not None and context.task_id and context.context_id


@pytest.mark.asyncio
async def test_public_http_transport_activation_and_borrowed_ownership() -> None:
    requests: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["A2A-Extensions"] == EXTENSION_URI
        assert request.headers["A2A-Version"] == "1.0"
        body = json.loads(request.content)
        assert body["method"] == "SendMessage"
        requests.append(body)
        return httpx.Response(
            200,
            json={
                "jsonrpc": "2.0",
                "id": body["id"],
                "result": {
                    "message": {
                        "messageId": "reply",
                        "role": "ROLE_AGENT",
                        "parts": [{"data": {"nested": None}}],
                    },
                },
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        transport = JsonRpcTransport(http, AgentCard(), "http://fixture.test/a2a")
        message = ParseDict(
            {
                "message": {
                    "messageId": "m",
                    "role": "ROLE_USER",
                    "parts": [{"data": {"nested": None}}],
                }
            },
            SendMessageRequest(),
        )
        result = await transport.send_message(
            message,
            context=ClientCallContext(
                service_parameters={"A2A-Extensions": EXTENSION_URI, "A2A-Version": "1.0"},
            ),
        )
        assert MessageToDict(result)["message"]["parts"][0]["data"] == {"nested": None}
        assert len(requests) == 1
        assert not http.is_closed


@pytest.mark.asyncio
async def test_public_transport_local_cancellation() -> None:
    entered = asyncio.Event()
    cleaned = asyncio.Event()

    async def handler(request: httpx.Request) -> httpx.Response:
        entered.set()
        try:
            await asyncio.Event().wait()
            raise AssertionError("cancelled transport must not finish")
        finally:
            cleaned.set()

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        transport = JsonRpcTransport(http, AgentCard(), "http://fixture.test/a2a")
        task = asyncio.create_task(transport.send_message(SendMessageRequest()))
        await entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert cleaned.is_set()
        assert not http.is_closed
