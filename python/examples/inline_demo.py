"""Runnable deterministic provider/client demo over real loopback HTTP and SSE.

Install the built wheel with [server] and uvicorn==0.42.0, then run this file.
Only public package imports are used. No workspace resources or credentials.
"""

import asyncio
import base64
import hashlib
import json
import socket
import ssl
import sys
from pathlib import Path
from typing import TypedDict

import uvicorn
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.types import AgentCard, Task
from google.protobuf.json_format import ParseDict

from a2a_schema_contract.client import ContractClient
from a2a_schema_contract.core import JSON_SCHEMA_DIALECT, JsonValue
from a2a_schema_contract.http import create_app
from a2a_schema_contract.resolver import ContractResolver
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


def create_provider(base_url: str, catalog: object = CATALOG) -> ContractServer:
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
    boundary = ContractServer(card=card, catalog=catalog, executor=executor, required=True)
    executor.boundary = boundary
    return boundary


async def demo(catalog: object = CATALOG, resolver: ContractResolver | None = None) -> None:
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    base_url = f"http://127.0.0.1:{listener.getsockname()[1]}"
    boundary = create_provider(base_url, catalog)
    server = uvicorn.Server(uvicorn.Config(create_app(boundary), log_level="error"))
    serving = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        async with asyncio.timeout(5):
            while not server.started:
                if serving.done():
                    await serving
                await asyncio.sleep(0.01)
        async with await ContractClient.discover(base_url, resolver=resolver) as client:
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


async def secure_demo(cert: Path, key: Path) -> None:
    """Pinned native resources on verified loopback TLS; fixture CA is test-only."""
    server_tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_tls.load_cert_chain(cert, key)
    client_tls = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    client_tls.load_verify_locations(cafile=str(cert))
    documents: dict[str, bytes] = {}
    requests = 0

    async def serve(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        nonlocal requests
        try:
            head = await reader.readuntil(b"\r\n\r\n")
            path = head.split(b" ")[1].decode("ascii")
            requests += 1
            body = documents[path]
            writer.write(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/schema+json\r\n"
                + f"Content-Length: {len(body)}\r\n\r\n".encode()
                + body
            )
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    listener = await asyncio.start_server(
        serve, "127.0.0.1", 0, ssl=server_tls, ssl_shutdown_timeout=0.1
    )
    base = f"https://127.0.0.1:{listener.sockets[0].getsockname()[1]}"
    documents["/v1/root.json"] = json.dumps(
        {
            "$defs": {
                "input": {"$ref": "types.json#/$defs/input"},
                "output": {"$ref": "types.json#/$defs/output"},
            }
        }
    ).encode()
    documents["/v1/types.json"] = json.dumps(
        {
            "$defs": {
                "input": schema("text")["inline"],
                "output": schema("reply")["inline"],
            }
        }
    ).encode()
    external = json.loads(json.dumps(CATALOG))
    for side in ("input", "output"):
        external["contracts"][0][side]["representations"][0]["schema"] = {
            "dialect": JSON_SCHEMA_DIALECT,
            "mediaType": "application/schema+json",
            "uri": base + "/v1/root.json#/$defs/" + side,
        }
    pins = {
        base + path: {
            "algorithm": "sha-256",
            "value": base64.b64encode(hashlib.sha256(body).digest()).decode(),
        }
        for path, body in documents.items()
    }
    try:
        async with ContractResolver(
            tls=client_tls,
            allowed_origins=(base,),
            allowed_addresses={"127.0.0.1": ("127.0.0.1",)},
            resource_integrity=pins,
        ) as resolver:
            prepared = await resolver.resolve_catalog(external, origin="local")
            await demo(prepared, resolver)
            assert requests == 2, "Pinned resource bytes should be reused without retrieval."
            resolver.clear_cache()
            assert prepared.schema(CONTRACT_ID, "input", "json") is not None
            assert prepared.select(CONTRACT_ID, "input", "json").validate({"text": "offline"})
        print("PASS: verified pinned HTTPS, native refs, cached discovery, offline resources")
    finally:
        listener.close()
        await listener.wait_closed()


if __name__ == "__main__":
    if len(sys.argv) == 3:
        asyncio.run(secure_demo(Path(sys.argv[1]), Path(sys.argv[2])))
    else:
        asyncio.run(demo())
