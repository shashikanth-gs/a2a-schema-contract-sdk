"""Deterministic provider and real-loopback fixture; no model credentials required."""

import asyncio
import socket
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Literal, cast

import uvicorn
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.server.routes.common import ServerCallContextBuilder
from a2a.types import AgentCard, Task, TaskArtifactUpdateEvent, TaskStatusUpdateEvent
from google.protobuf.json_format import MessageToDict, ParseDict

from a2a_schema_contract.core import JSON_SCHEMA_DIALECT, MISSING, JsonValue
from a2a_schema_contract.http import create_app
from a2a_schema_contract.server import ContractServer, output_artifact

ID = "urn:example:contract:echo:1"


def catalog(
    input_presence: Literal["required", "optional", "none"] = "required",
    output_presence: Literal["required", "optional", "none"] = "required",
    *,
    schema: JsonValue = True,
    media: str = "application/json",
) -> dict[str, JsonValue]:
    def direction(presence: str) -> dict[str, JsonValue]:
        if presence == "none":
            return {"presence": presence}
        return {
            "presence": presence,
            "representations": [
                {
                    "id": "json",
                    "mediaType": media,
                    "schema": {
                        "dialect": JSON_SCHEMA_DIALECT,
                        "mediaType": "application/schema+json",
                        "inline": schema,
                    },
                }
            ],
        }

    return {
        "contracts": [
            {
                "id": ID,
                "skillIds": ["echo"],
                "input": direction(input_presence),
                "output": direction(output_presence),
            }
        ]
    }


def card(base: str) -> AgentCard:
    return ParseDict(
        {
            "name": "Contract echo",
            "description": "Deterministic inline acceptance provider",
            "version": "1.0.0",
            "supportedInterfaces": [
                {
                    "url": base + "/a2a",
                    "protocolBinding": "JSONRPC",
                    "protocolVersion": "1.0",
                }
            ],
            "capabilities": {"streaming": True},
            "defaultInputModes": ["application/json"],
            "defaultOutputModes": ["application/json"],
            "skills": [
                {
                    "id": "echo",
                    "name": "Echo",
                    "description": "Echo a validated value",
                    "tags": ["test"],
                }
            ],
        },
        AgentCard(),
    )


class EchoExecutor(AgentExecutor):
    def __init__(self, *, output: object = MISSING, pause: float = 0) -> None:
        self.server: ContractServer
        self.calls = 0
        self.cancels = 0
        self.output, self.pause = output, pause

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        self.calls += 1
        execution = self.server.execution(context)
        await event_queue.enqueue_event(
            ParseDict(
                {
                    "id": context.task_id,
                    "contextId": context.context_id,
                    "status": {"state": "TASK_STATE_WORKING"},
                },
                Task(),
            )
        )
        if self.pause:
            await asyncio.sleep(self.pause)
        if execution.selection.output is not None:
            value = execution.input if self.output is MISSING else self.output
            artifact = output_artifact(execution, value)
            await event_queue.enqueue_event(
                ParseDict(
                    {
                        "taskId": context.task_id,
                        "contextId": context.context_id,
                        "artifact": MessageToDict(artifact),
                        "lastChunk": True,
                    },
                    TaskArtifactUpdateEvent(),
                )
            )
        await event_queue.enqueue_event(
            ParseDict(
                {
                    "taskId": context.task_id,
                    "contextId": context.context_id,
                    "status": {"state": "TASK_STATE_COMPLETED"},
                },
                TaskStatusUpdateEvent(),
            )
        )

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        self.cancels += 1


@asynccontextmanager
async def provider(
    raw: object = MISSING,
    *,
    executor: EchoExecutor | None = None,
    required: bool = True,
    deadline: float = 30,
    context_builder: ServerCallContextBuilder | None = None,
) -> AsyncIterator[tuple[str, ContractServer, EchoExecutor]]:
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    base = f"http://127.0.0.1:{listener.getsockname()[1]}"
    actual = executor if executor is not None else EchoExecutor()
    boundary = ContractServer(
        card=card(base),
        catalog=catalog() if raw is MISSING else raw,
        executor=actual,
        required=required,
        deadline=deadline,
    )
    actual.server = boundary
    http = uvicorn.Server(
        uvicorn.Config(
            create_app(boundary, context_builder=context_builder), log_level="error", lifespan="on"
        )
    )
    task = asyncio.create_task(http.serve(sockets=[listener]))
    try:
        async with asyncio.timeout(5):
            while not http.started:
                if task.done():
                    await task
                await asyncio.sleep(0.01)
        yield base, boundary, actual
    finally:
        http.should_exit = True
        # Cancel owned application work before waiting for HTTP connections to drain.
        await boundary.close()
        await asyncio.wait_for(task, 5)
        listener.close()


def as_dict(value: JsonValue) -> dict[str, JsonValue]:
    return cast("dict[str, JsonValue]", value)
