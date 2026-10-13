"""Cancellation, continuation, admission and authorization over real HTTP/SSE."""

import asyncio
import json
from typing import cast

import httpx
import pytest
from a2a.auth.user import User
from a2a.client import ClientCallContext
from a2a.server.agent_execution import RequestContext
from a2a.server.context import ServerCallContext
from a2a.server.events import EventQueue
from a2a.server.routes.common import DefaultServerCallContextBuilder
from a2a.types import Task
from a2a.utils.errors import InvalidParamsError, TaskNotFoundError
from google.protobuf.json_format import ParseDict
from starlette.requests import Request

from a2a_schema_contract.client import ContractClient
from a2a_schema_contract.core import EXTENSION_URI, JsonValue

from .inline_support import ID, EchoExecutor, as_dict, provider


class Principal(User):
    def __init__(self, name: str) -> None:
        self.name = name

    @property
    def is_authenticated(self) -> bool:
        return True

    @property
    def user_name(self) -> str:
        return self.name


class TrustedBuilder(DefaultServerCallContextBuilder):
    def build(self, request: Request) -> ServerCallContext:
        context = super().build(request)
        # Test-only simulated host authentication. Production uses verified credentials.
        context.user = Principal(request.headers.get("x-test-principal", "owner"))
        context.tenant = request.headers.get("x-test-tenant", "host")
        return context


class ContinueExecutor(EchoExecutor):
    def __init__(self) -> None:
        super().__init__()
        self.first = True

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        if self.first:
            self.first = False
            self.calls += 1
            await event_queue.enqueue_event(
                ParseDict(
                    {
                        "id": context.task_id,
                        "contextId": context.context_id,
                        "status": {"state": "TASK_STATE_INPUT_REQUIRED"},
                    },
                    Task(),
                )
            )
        else:
            await super().execute(context, event_queue)


class SlowCancelExecutor(EchoExecutor):
    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        self.cancels += 1
        # Business execution may finish while an application cancellation callback awaits.
        await asyncio.sleep(0.1)


@pytest.mark.asyncio
async def test_input_required_continuation_pins_contract_and_owner() -> None:
    executor = ContinueExecutor()
    async with (
        provider(executor=executor, context_builder=TrustedBuilder()) as (base, _, _),
        await ContractClient.discover(base) as client,
    ):
        result = await client.invoke(client.prepare(ID, input={}))
        task = as_dict(result.response.value)
        assert as_dict(task["status"])["state"] == "TASK_STATE_INPUT_REQUIRED"
        assert result.payload is None
        task_id = cast("str", task["id"])
        context_id = cast("str", task["contextId"])
        await client.get_task(task_id)
        foreign = ClientCallContext(service_parameters={"x-test-principal": "other"})
        with pytest.raises(TaskNotFoundError):
            await client.get_task(task_id, context=foreign)
        with pytest.raises(TaskNotFoundError):
            await client.cancel_task(task_id, context=foreign)
        assert executor.cancels == 0
        # A caller cannot overwrite the trusted tenant using JSON-RPC params.
        with pytest.raises(InvalidParamsError):
            await client.invoke(
                client.prepare(ID, input={}, task_id=task_id, context_id=context_id, tenant="other")
            )
        assert executor.calls == 1
        resumed = await client.invoke(
            client.prepare(ID, input={"resumed": True}, task_id=task_id, context_id=context_id)
        )
        assert (
            resumed.payload
            and resumed.payload.present
            and resumed.payload.value == {"resumed": True}
        )
        with pytest.raises(InvalidParamsError):
            await client.invoke(
                client.prepare(ID, input={}, task_id=task_id, context_id=context_id)
            )
        assert executor.calls == 2


@pytest.mark.asyncio
async def test_remote_cancel_authorized_before_executor_hook() -> None:
    executor = EchoExecutor(pause=5)
    async with (
        provider(executor=executor, context_builder=TrustedBuilder()) as (base, server, _),
        await ContractClient.discover(base) as client,
    ):
        stream = client.stream(client.prepare(ID, input={}))
        first = await anext(stream)
        task_id = cast("str", as_dict(as_dict(first.event.value)["data"])["id"])
        with pytest.raises(TaskNotFoundError):
            await client.cancel_task(
                task_id, context=ClientCallContext(service_parameters={"x-test-tenant": "other"})
            )
        assert executor.cancels == 0
        canceled = await client.cancel_task(task_id)
        assert as_dict(as_dict(canceled.value)["status"])["state"] == "TASK_STATE_CANCELED"
        assert executor.cancels == 1
        rest = [event async for event in stream]
        assert rest[-1].result and rest[-1].result.payload is None
        assert not server._active


@pytest.mark.asyncio
async def test_local_stream_close_releases_connection_without_remote_cancel() -> None:
    executor = EchoExecutor(pause=0.1)
    async with (
        provider(executor=executor) as (base, server, _),
        await ContractClient.discover(base) as client,
    ):
        stream = client.stream(client.prepare(ID, input={}))
        await anext(stream)
        await stream.aclose()
        assert not client._streams
        assert executor.cancels == 0
        # Transport abort is distinct from an explicit authorized CancelTask RPC.
        await asyncio.wait_for(asyncio.gather(*tuple(server._active.values())), 2)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutation",
    [
        "duplicate-json",
        "nonfinite",
        "body-limit",
        "unknown-method",
        "null-parts",
        "unknown-role",
        "null-filename",
        "unknown-field",
        "history-negative",
        "immediate",
        "missing-activation",
        "message-selection",
        "metadata-null",
    ],
)
async def test_raw_http_admission_zero_execution(mutation: str) -> None:
    async with (
        provider() as (base, _, executor),
        await ContractClient.discover(base) as client,
        httpx.AsyncClient() as http,
    ):
        params = as_dict(client.prepare(ID, input={}).request.value)
        method = "SendMessage"
        headers = {
            "A2A-Extensions": EXTENSION_URI,
            "A2A-Version": "1.0",
            "content-type": "application/json",
        }
        message = as_dict(params["message"])
        if mutation == "unknown-method":
            method = "ListTasks"
        elif mutation == "null-parts":
            message["parts"] = None
        elif mutation == "unknown-role":
            message["role"] = "UNKNOWN"
        elif mutation == "null-filename":
            as_dict(cast("list[JsonValue]", message["parts"])[0])["filename"] = None
        elif mutation == "unknown-field":
            message["unknown"] = True
        elif mutation == "history-negative":
            params["configuration"] = {"historyLength": -1}
        elif mutation == "immediate":
            params["configuration"] = {"returnImmediately": True}
        elif mutation == "missing-activation":
            del headers["A2A-Extensions"]
        elif mutation == "message-selection":
            message["metadata"] = params["metadata"]
        elif mutation == "metadata-null":
            params["metadata"] = None
        body = json.dumps(
            {"jsonrpc": "2.0", "id": "bad", "method": method, "params": params}
        ).encode()
        if mutation == "duplicate-json":
            body = b'{"jsonrpc":"2.0","jsonrpc":"2.0"}'
        elif mutation == "nonfinite":
            body = b'{"params":NaN}'
        elif mutation == "body-limit":
            body = b" " * 262145
        response = await http.post(base + "/a2a", content=body, headers=headers)
        assert "error" in response.json()
        assert executor.calls == 0


@pytest.mark.asyncio
async def test_trusted_tenant_empty_wire_does_not_reset_host_scope() -> None:
    async with (
        provider(context_builder=TrustedBuilder()) as (base, _, _),
        await ContractClient.discover(base) as client,
    ):
        result = await client.invoke(client.prepare(ID, input={}, tenant="host"))
        task_id = cast("str", as_dict(result.response.value)["id"])
        assert as_dict((await client.get_task(task_id)).value)["id"] == task_id
        with pytest.raises(TaskNotFoundError):
            await client.get_task(
                task_id, context=ClientCallContext(service_parameters={"x-test-tenant": ""})
            )


@pytest.mark.asyncio
async def test_request_scoped_selection_with_concurrent_values() -> None:
    async with (
        provider(executor=EchoExecutor(pause=0.05)) as (base, server, _),
        await ContractClient.discover(base) as client,
    ):
        results = await asyncio.gather(
            *(client.invoke(client.prepare(ID, input={"n": n})) for n in range(4))
        )
        assert [
            result.payload.value for result in results if result.payload and result.payload.present
        ] == [{"n": n} for n in range(4)]
        assert not server._active and not server._selections


@pytest.mark.asyncio
async def test_cancel_reserves_gate_before_awaiting_application_cleanup() -> None:
    executor = SlowCancelExecutor(pause=0.05)
    async with (
        provider(executor=executor) as (base, server, _),
        await ContractClient.discover(base) as client,
    ):
        stream = client.stream(client.prepare(ID, input={"must-not-publish": True}))
        progress = await anext(stream)
        task_id = cast("str", as_dict(as_dict(progress.event.value)["data"])["id"])
        canceled = await client.cancel_task(task_id)
        assert as_dict(as_dict(canceled.value)["status"])["state"] == "TASK_STATE_CANCELED"
        events = [event async for event in stream]
        result = events[-1].result
        assert result is not None and result.payload is None
        assert not as_dict(result.response.value).get("artifacts")
        assert executor.cancels == 1
        assert not server._cancel_requests and not server._publishing
