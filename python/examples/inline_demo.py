"""Runnable deterministic provider/client demo over real loopback HTTP and SSE.

Install the built wheel with [server] and uvicorn==0.42.0, then run this file.
Only public package imports are used. No workspace resources or credentials.
"""

import asyncio
import socket
from typing import TypedDict

import uvicorn
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.types import AgentCard, Task
from google.protobuf.json_format import ParseDict

from a2a_schema_contract.client import ContractClient
from a2a_schema_contract.core import JSON_SCHEMA_DIALECT, JsonValue
from a2a_schema_contract.http import create_app
from a2a_schema_contract.server import ContractServer, output_artifact

CONTRACT_ID = "urn:example:contract:echo:1"


class EchoInput(TypedDict):
    text: str


def schema(field: str) -> dict[str, JsonValue]:
    return {
        "mediaType": "application/schema+json",
        "dialect": JSON_SCHEMA_DIALECT,
        "inline": {
            "type": "object",
            "required": [field],
            "properties": {
                field: {"type": "string"},
            },
            "additionalProperties": False,
        },
    }


CATALOG = {
    "contracts": [
        {
            "id": CONTRACT_ID,
            "description": "Echo a message",
            "skillIds": ["echo"],
            "input": {
                "presence": "required",
                "representations": [
                    {
                        "id": "json",
                        "mediaType": "application/json",
                        "schema": schema("text"),
                    }
                ],
            },
            "output": {
                "presence": "required",
                "representations": [
                    {
                        "id": "json",
                        "mediaType": "application/json",
                        "schema": schema("reply"),
                    }
                ],
            },
        }
    ]
}


class EchoAgent(AgentExecutor):
    def __init__(self) -> None:
        self.boundary: ContractServer

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        execution = self.boundary.execution(context)
        assert execution.selection.input.present
        value = execution.selection.input.value
        assert isinstance(value, dict) and isinstance(value["text"], str)
        # The application owns this business work; a framework/model can supply it.
        artifact = output_artifact(execution, {"reply": value["text"]})
        await event_queue.enqueue_event(
            Task(
                id=execution.task_id,
                context_id=execution.context_id,
                status={"state": "TASK_STATE_COMPLETED"},
                artifacts=[artifact],
            )
        )

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        # Release application-owned model/tool work here when present.
        return


def create_provider(base_url: str) -> ContractServer:
    card = ParseDict(
        {
            "name": "Echo agent",
            "description": "A small contracted agent",
            "version": "1.0.0",
            "supportedInterfaces": [
                {"url": base_url + "/a2a", "protocolBinding": "JSONRPC", "protocolVersion": "1.0"}
            ],
            "capabilities": {"streaming": True},
            "defaultInputModes": ["application/json"],
            "defaultOutputModes": ["application/json"],
            "skills": [
                {
                    "id": "echo",
                    "name": "Echo",
                    "description": "Echo a text message",
                    "tags": ["example"],
                }
            ],
        },
        AgentCard(),
    )
    executor = EchoAgent()
    boundary = ContractServer(card=card, catalog=CATALOG, executor=executor, required=True)
    executor.boundary = boundary
    return boundary


async def demo() -> None:
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    base_url = f"http://127.0.0.1:{listener.getsockname()[1]}"
    boundary = create_provider(base_url)
    server = uvicorn.Server(uvicorn.Config(create_app(boundary), log_level="error"))
    serving = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        async with asyncio.timeout(5):
            while not server.started:
                if serving.done():
                    await serving
                await asyncio.sleep(0.01)
        async with await ContractClient.discover(base_url) as client:
            # Known contract: use the application's own static request type.
            typed_request: EchoInput = {"text": "Hello from a typed request"}
            result = await client.invoke(client.prepare(CONTRACT_ID, input=typed_request))
            assert result.payload and result.payload.present
            assert result.payload.value == {"reply": typed_request["text"]}
            # Discovery: a caller/model chooses a skill; the SDK resolves its binding.
            contract = client.bind_skill("echo")
            discovered = client.catalog.schema(contract.id, "input", "json")
            assert discovered is not None
            assert isinstance(discovered.descriptor.value, dict)
            invocation = client.prepare(contract.id, input={"text": "Hello from discovery"})
            events = [event async for event in client.stream(invocation)]
            final = events[-1].result
            assert final and final.payload and final.payload.present
            assert final.payload.value == {"reply": "Hello from discovery"}
        print("PASS: discovery, typed invocation, schema inspection, HTTP and SSE")
    finally:
        server.should_exit = True
        await asyncio.wait_for(serving, 5)
        listener.close()
        await boundary.close()


if __name__ == "__main__":
    asyncio.run(demo())
