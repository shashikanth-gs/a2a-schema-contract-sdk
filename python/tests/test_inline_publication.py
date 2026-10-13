"""Host executor failures, output presence, continuation races and publication cleanup."""

from contextlib import suppress
from typing import cast

import pytest
from a2a.server.agent_execution import RequestContext
from a2a.server.events import EventQueue
from a2a.types import Task, TaskStatusUpdateEvent
from a2a.utils.errors import InvalidParamsError
from google.protobuf.json_format import ParseDict

from a2a_schema_contract.client import ContractClient
from a2a_schema_contract.core import EXTENSION_URI, MISSING, ContractError, JsonValue
from a2a_schema_contract.server import output_message

from .inline_support import ID, EchoExecutor, as_dict, catalog, provider
from .test_inline_lifecycle import ContinueExecutor


class PublicationExecutor(EchoExecutor):
    def __init__(self, mode: str) -> None:
        super().__init__()
        self.mode = mode
        self.saved: EventQueue | None = None
        self.context: RequestContext | None = None

    async def execute(self, context: RequestContext, queue: EventQueue) -> None:
        self.calls += 1
        self.saved, self.context = queue, context
        execution = self.server.execution(context)
        if self.mode == "message":
            await queue.enqueue_event(output_message(execution, execution.input))
        elif self.mode in (
            "optional-absent",
            "exception",
            "poison",
            "limit",
            "late",
            "wrong-id",
            "wrong-echo",
            "history",
        ):
            first: dict[str, JsonValue] = {
                "id": context.task_id,
                "contextId": context.context_id,
                "status": {"state": "TASK_STATE_WORKING"},
            }
            if self.mode == "wrong-id":
                first["id"] = "foreign"
            elif self.mode == "wrong-echo":
                first["metadata"] = {EXTENSION_URI: {"contractId": "urn:foreign:1"}}
            elif self.mode == "history":
                first["history"] = [
                    {"messageId": "history", "role": "ROLE_USER", "parts": [{"text": ""}]}
                ]
            await queue.enqueue_event(ParseDict(first, Task()))
            if self.mode == "exception":
                raise RuntimeError("private-executor-secret")
            if self.mode == "poison":
                with suppress(ContractError):
                    # UNSPECIFIED disappears from protobuf JSON; the publication gate rejects it.
                    await queue.enqueue_event(
                        TaskStatusUpdateEvent(
                            task_id=context.task_id, context_id=context.context_id
                        )
                    )
            if self.mode == "limit":
                for _ in range(130):
                    await queue.enqueue_event(
                        ParseDict(
                            {
                                "taskId": context.task_id,
                                "contextId": context.context_id,
                                "status": {"state": "TASK_STATE_WORKING"},
                            },
                            TaskStatusUpdateEvent(),
                        )
                    )
            await queue.enqueue_event(
                ParseDict(
                    {
                        "taskId": context.task_id,
                        "contextId": context.context_id,
                        "status": {"state": "TASK_STATE_COMPLETED"},
                    },
                    TaskStatusUpdateEvent(),
                )
            )
        else:
            raise AssertionError("Unknown fixture mode")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mode", ["exception", "poison", "limit", "wrong-id", "wrong-echo", "history"]
)
async def test_executor_failure_does_not_publish_business_output(mode: str) -> None:
    async with (
        provider(executor=PublicationExecutor(mode)) as (base, server, executor),
        await ContractClient.discover(base) as client,
    ):
        events = [event async for event in client.stream(client.prepare(ID, input={}))]
        result = events[-1].result
        assert result and result.payload is None
        task = as_dict(result.response.value)
        assert as_dict(task["status"])["state"] == "TASK_STATE_FAILED"
        assert not task.get("artifacts")
        assert "private-executor-secret" not in str(task)
        assert executor.calls == 1 and not server._executions


@pytest.mark.asyncio
@pytest.mark.parametrize("streaming", [False, True])
async def test_optional_output_absent_and_standalone_message(streaming: bool) -> None:
    for mode in ("optional-absent", "message"):
        async with (
            provider(catalog("optional", "optional"), executor=PublicationExecutor(mode)) as (
                base,
                _,
                _,
            ),
            await ContractClient.discover(base) as client,
        ):
            invocation = client.prepare(
                ID, input=MISSING if mode == "optional-absent" else {"nested": None}
            )
            if streaming:
                events = [event async for event in client.stream(invocation)]
                result = events[-1].result
            else:
                result = await client.invoke(invocation)
            assert result is not None and result.payload is not None
            assert result.payload.present == (mode == "message")


@pytest.mark.asyncio
@pytest.mark.parametrize("value", ["", "café", "a\nb"])
async def test_text_carrier_over_real_http(value: str) -> None:
    async with (
        provider(catalog(media="text/plain; charset=utf-8", schema={"type": "string"})) as (
            base,
            _,
            _,
        ),
        await ContractClient.discover(base) as client,
    ):
        result = await client.invoke(
            client.prepare(ID, input=value, accepted_output_modes=["text/plain; charset=utf-8"])
        )
        assert result.payload and result.payload.present and result.payload.value == value


@pytest.mark.asyncio
async def test_late_events_and_helpers_cannot_publish_after_completion() -> None:
    executor = PublicationExecutor("message")
    async with (
        provider(executor=executor) as (base, server, _),
        await ContractClient.discover(base) as client,
    ):
        await client.invoke(client.prepare(ID, input={}))
        assert executor.saved is not None and executor.context is not None
        with pytest.raises(ContractError, match="VALIDATION_ABORTED"):
            await executor.saved.enqueue_event(Task())
        with pytest.raises(RuntimeError, match="No active"):
            server.execution(executor.context)


@pytest.mark.asyncio
async def test_concurrent_resume_is_rejected_before_second_execution() -> None:
    executor = ContinueExecutor()
    executor.pause = 5
    async with (
        provider(executor=executor) as (base, _, _),
        await ContractClient.discover(base) as client,
    ):
        task = as_dict((await client.invoke(client.prepare(ID, input={}))).response.value)
        invocation = client.prepare(
            ID, input={}, task_id=cast("str", task["id"]), context_id=cast("str", task["contextId"])
        )
        stream = client.stream(invocation)
        await anext(stream)
        with pytest.raises(InvalidParamsError):
            await client.invoke(invocation)
        assert executor.calls == 2
        await client.cancel_task(cast("str", task["id"]))
        await stream.aclose()


@pytest.mark.asyncio
async def test_server_close_cancels_owned_work_and_client_close_releases_streams() -> None:
    async with provider(executor=EchoExecutor(pause=5)) as (base, server, _):
        client = await ContractClient.discover(base)
        stream = client.stream(client.prepare(ID, input={}))
        await anext(stream)
        await server.close()
        await server.close()
        assert not server._active and not server._executions
        await client.close()
        assert not client._streams
        await stream.aclose()
