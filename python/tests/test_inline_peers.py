"""Nonconforming peer rejection before SDK normalization or business publication."""

import json
from collections.abc import AsyncIterator, Callable
from typing import cast

import httpx
import pytest
from google.protobuf.json_format import MessageToDict

from a2a_schema_contract.catalog import create_contract_extension, parse_catalog
from a2a_schema_contract.client import ContractClient
from a2a_schema_contract.core import EXTENSION_URI, ContractError, JsonValue
from a2a_schema_contract.core.models import JsonDocument
from a2a_schema_contract.payload import encode_primary

from .inline_support import ID, as_dict, card, catalog


def advertisement(raw: object | None = None) -> dict[str, JsonValue]:
    value = as_dict(MessageToDict(card("http://peer.test")))
    as_dict(value["capabilities"])["extensions"] = [
        create_contract_extension(parse_catalog(catalog() if raw is None else raw))
    ]
    return value


def final_task(value: JsonValue = 1) -> dict[str, JsonValue]:
    part = encode_primary(parse_catalog(catalog()).select(ID, "output", "json"), value)
    return {
        "id": "task",
        "contextId": "context",
        "status": {"state": "TASK_STATE_COMPLETED"},
        "metadata": {EXTENSION_URI: {"contractId": ID, "outputRepresentationId": "json"}},
        "artifacts": [{"artifactId": "output", "parts": [part]}],
    }


def primary(task: dict[str, JsonValue]) -> dict[str, JsonValue]:
    return as_dict(
        cast("list[JsonValue]", as_dict(cast("list[JsonValue]", task["artifacts"])[0])["parts"])[0]
    )


class Chunks(httpx.AsyncByteStream):
    def __init__(self, body: bytes) -> None:
        self.body = body
        self.closed = False

    async def __aiter__(self) -> AsyncIterator[bytes]:
        # Splits UTF-8 and SSE delimiters across reads to exercise incremental admission.
        for index in range(0, len(self.body), 7):
            yield self.body[index : index + 7]

    async def aclose(self) -> None:
        self.closed = True


def mock_peer(
    reply: Callable[[dict[str, JsonValue]], httpx.Response],
    raw: object | None = None,
) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json=advertisement(raw))
        return reply(as_dict(json.loads(request.content)))

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutation",
    [
        "filename-null",
        "text-number",
        "two-carriers",
        "metadata-null",
        "media-null",
        "bad-role",
        "unknown-state",
        "part-unknown",
        "no-primary",
        "two-primaries",
        "instance-invalid",
        "part-contract",
        "part-direction",
        "part-representation",
        "wrong-media",
        "echo-absent",
        "echo-contract",
        "echo-representation",
        "context",
        "task-id",
        "duplicate-artifact",
        "failed-primary",
        "input-required-primary",
        "status-primary",
        "history-invalid",
        "unsafe-number",
        "no-oneof",
        "two-oneofs",
        "response-id",
        "raw-null",
        "task-null",
        "unknown-field",
    ],
)
async def test_nonconforming_json_peer(mutation: str) -> None:
    task = final_task()
    part = primary(task)
    result: dict[str, JsonValue] = {"task": task}
    if mutation == "filename-null":
        part["filename"] = None
    elif mutation == "text-number":
        del part["data"]
        part["text"] = 1
    elif mutation == "two-carriers":
        part["text"] = "extra"
    elif mutation == "metadata-null":
        part["metadata"] = None
    elif mutation == "media-null":
        part["mediaType"] = None
    elif mutation == "bad-role":
        result = {
            "message": {
                "messageId": "reply",
                "contextId": "context",
                "role": "bad",
                "parts": [part],
                "metadata": task["metadata"],
            }
        }
    elif mutation == "unknown-state":
        as_dict(task["status"])["state"] = "NEW_UNKNOWN_ENUM"
    elif mutation == "part-unknown":
        part["extra"] = True
    elif mutation == "no-primary":
        del part["metadata"]
    elif mutation == "two-primaries":
        cast(
            "list[JsonValue]", as_dict(cast("list[JsonValue]", task["artifacts"])[0])["parts"]
        ).append(part)
    elif mutation == "instance-invalid":
        part["data"] = "invalid-for-integer"
    elif mutation.startswith("part-"):
        marker = as_dict(as_dict(part["metadata"])[EXTENSION_URI])
        field = {
            "part-contract": "contractId",
            "part-direction": "direction",
            "part-representation": "representationId",
        }[mutation]
        marker[field] = (
            "urn:other:1" if field == "contractId" else "input" if field == "direction" else "other"
        )
    elif mutation == "wrong-media":
        part["mediaType"] = "text/plain"
    elif mutation == "echo-absent":
        del task["metadata"]
    elif mutation.startswith("echo-"):
        as_dict(as_dict(task["metadata"])[EXTENSION_URI])[
            "contractId" if mutation == "echo-contract" else "outputRepresentationId"
        ] = "urn:other:1" if mutation == "echo-contract" else "other"
    elif mutation == "context":
        task["contextId"] = "foreign"
    elif mutation == "task-id":
        task["id"] = "foreign"
    elif mutation == "duplicate-artifact":
        cast("list[JsonValue]", task["artifacts"]).append(
            cast("list[JsonValue]", task["artifacts"])[0]
        )
    elif mutation in ("failed-primary", "input-required-primary"):
        as_dict(task["status"])["state"] = (
            "TASK_STATE_FAILED" if mutation == "failed-primary" else "TASK_STATE_INPUT_REQUIRED"
        )
    elif mutation == "status-primary":
        as_dict(task["status"])["message"] = {
            "messageId": "status",
            "role": "ROLE_AGENT",
            "parts": [part],
        }
    elif mutation == "history-invalid":
        task["history"] = [None]
    elif mutation == "unsafe-number":
        part["data"] = 9007199254740992
    elif mutation == "no-oneof":
        result = {}
    elif mutation == "two-oneofs":
        result["message"] = {"messageId": "m", "role": "ROLE_AGENT", "parts": [{"text": ""}]}
    elif mutation == "raw-null":
        del part["data"]
        part["raw"] = None
    elif mutation == "task-null":
        result["task"] = None
    elif mutation == "unknown-field":
        task["extra"] = True
    raw_catalog = catalog(schema={"type": "integer"})
    async with (
        mock_peer(
            lambda request: httpx.Response(
                200,
                json={
                    "jsonrpc": "2.0",
                    "id": "foreign" if mutation == "response-id" else request["id"],
                    "result": result,
                },
            ),
            raw_catalog,
        ) as http,
        await ContractClient.discover("http://peer.test", http_client=http) as client,
    ):
        with pytest.raises(ContractError):
            await client.invoke(client.prepare(ID, input=1, context_id="context", task_id="task"))


def sse_response(
    request: dict[str, JsonValue], events: list[JsonValue], *, suffix: bytes = b""
) -> tuple[httpx.Response, Chunks]:
    body = (
        b"".join(
            (
                "data: "
                + json.dumps(
                    {"jsonrpc": "2.0", "id": request["id"], "result": event}, ensure_ascii=False
                )
                + "\r\n\r\n"
            ).encode()
            for event in events
        )
        + suffix
    )
    chunks = Chunks(body)
    return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=chunks), chunks


def events() -> list[JsonValue]:
    task = final_task({"emoji": "😀"})
    return [
        {"task": {"id": "task", "contextId": "context", "status": {"state": "TASK_STATE_WORKING"}}},
        {
            "artifactUpdate": {
                "taskId": "task",
                "contextId": "context",
                "lastChunk": True,
                "artifact": cast("list[JsonValue]", task["artifacts"])[0],
            }
        },
        {
            "statusUpdate": {
                "taskId": "task",
                "contextId": "context",
                "status": task["status"],
                "metadata": task["metadata"],
            }
        },
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutation",
    [
        "valid",
        "append",
        "partial",
        "duplicate",
        "identity",
        "late",
        "truncated",
        "missing-initial",
        "missing-final",
        "echo-conflict",
        "state-unknown",
        "last-null",
        "byte-limit",
        "event-limit",
    ],
)
async def test_incremental_sse_atomic_admission(mutation: str) -> None:
    candidates = events()
    suffix = b""
    if mutation == "append":
        as_dict(as_dict(candidates[1])["artifactUpdate"])["append"] = True
    elif mutation == "partial":
        as_dict(as_dict(candidates[1])["artifactUpdate"])["lastChunk"] = False
    elif mutation == "duplicate":
        candidates.insert(2, candidates[1])
    elif mutation == "identity":
        as_dict(as_dict(candidates[1])["artifactUpdate"])["contextId"] = "foreign"
    elif mutation == "late":
        candidates.append(candidates[-1])
    elif mutation == "truncated":
        suffix = b"data: {"
    elif mutation == "missing-initial":
        candidates.pop(0)
    elif mutation == "missing-final":
        candidates.pop()
    elif mutation == "echo-conflict":
        as_dict(as_dict(candidates[0])["task"])["metadata"] = {
            EXTENSION_URI: {"contractId": "urn:wrong:1"}
        }
    elif mutation == "state-unknown":
        as_dict(as_dict(as_dict(candidates[-1])["statusUpdate"])["status"])["state"] = "UNKNOWN"
    elif mutation == "last-null":
        as_dict(as_dict(candidates[1])["artifactUpdate"])["lastChunk"] = None
    elif mutation == "byte-limit":
        suffix = b":" + b"a" * 262144 + b"\n\n"
    elif mutation == "event-limit":
        working: JsonValue = {
            "statusUpdate": {
                "taskId": "task",
                "contextId": "context",
                "status": {"state": "TASK_STATE_WORKING"},
            }
        }
        candidates[1:1] = [working] * 128
    streams: list[Chunks] = []

    def reply(request: dict[str, JsonValue]) -> httpx.Response:
        response, chunks = sse_response(request, candidates, suffix=suffix)
        streams.append(chunks)
        return response

    async with (
        mock_peer(reply) as http,
        await ContractClient.discover("http://peer.test", http_client=http) as client,
    ):
        published = []
        if mutation == "valid":
            published = [event async for event in client.stream(client.prepare(ID, input={}))]
            assert (
                published[-1].result
                and published[-1].result.payload
                and published[-1].result.payload.present
            )
            assert published[-1].result.payload.value == {"emoji": "😀"}
        else:
            with pytest.raises(ContractError):
                async for event in client.stream(
                    client.prepare(ID, input={})
                ):  # partial business value must never escape
                    published.append(event)
            assert all(event.result is None for event in published)
        assert streams[0].closed


@pytest.mark.asyncio
@pytest.mark.parametrize("body", [b'{"jsonrpc":"2.0","jsonrpc":"2.0"}', b'{"value":NaN}', b"\xff"])
async def test_malformed_json_admission(body: bytes) -> None:
    async with (
        mock_peer(lambda _: httpx.Response(200, content=body)) as http,
        await ContractClient.discover("http://peer.test", http_client=http) as client,
    ):
        with pytest.raises(ContractError):
            await client.invoke(client.prepare(ID, input={}))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutation",
    [
        "no-extension",
        "duplicate-extension",
        "required-null",
        "wrong-interface",
        "cross-origin",
        "bad-url",
        "invalid-skills",
    ],
)
async def test_discovery_rejects_unusable_or_normalized_advertisements(mutation: str) -> None:
    value = advertisement()
    extensions = cast("list[JsonValue]", as_dict(value["capabilities"])["extensions"])
    if mutation == "no-extension":
        extensions.clear()
    elif mutation == "duplicate-extension":
        extensions.append(extensions[0])
    elif mutation == "required-null":
        as_dict(extensions[0])["required"] = None
    elif mutation == "wrong-interface":
        as_dict(cast("list[JsonValue]", value["supportedInterfaces"])[0])["protocolVersion"] = "0.3"
    elif mutation in ("cross-origin", "bad-url"):
        as_dict(cast("list[JsonValue]", value["supportedInterfaces"])[0])["url"] = (
            "http://foreign.test/a2a" if mutation == "cross-origin" else "not-a-url"
        )
    else:
        as_dict(cast("list[JsonValue]", value["skills"])[0])["id"] = None
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(200, json=value))
    ) as http:
        with pytest.raises(ContractError):
            await ContractClient.discover("http://peer.test", http_client=http)
        assert not http.is_closed


@pytest.mark.asyncio
async def test_peer_may_choose_any_accepted_output() -> None:
    raw = catalog()
    contract = as_dict(cast("list[JsonValue]", raw["contracts"])[0])
    reps = cast("list[JsonValue]", as_dict(contract["output"])["representations"])
    second = as_dict(JsonDocument(reps[0]).value)
    second["id"] = "json2"
    reps.append(second)
    task = final_task(7)
    as_dict(as_dict(task["metadata"])[EXTENSION_URI])["outputRepresentationId"] = "json2"
    as_dict(as_dict(primary(task)["metadata"])[EXTENSION_URI])["representationId"] = "json2"
    async with (
        mock_peer(
            lambda request: httpx.Response(
                200, json={"jsonrpc": "2.0", "id": request["id"], "result": {"task": task}}
            ),
            raw,
        ) as http,
        await ContractClient.discover("http://peer.test", http_client=http) as client,
    ):
        result = await client.invoke(
            client.prepare(ID, input={}, accepted_output_representation_ids=["json", "json2"])
        )
        assert result.payload and result.payload.present and result.payload.value == 7
        invocation = client.prepare(ID, input={}, allow_server_selection=True)
        request = as_dict(invocation.request.value)
        assert "acceptedOutputRepresentationIds" not in as_dict(
            as_dict(request["metadata"])[EXTENSION_URI]
        )
        result = await client.invoke(invocation)
        assert result.payload and result.payload.present and result.payload.value == 7
        assert result.payload.representation_id == "json2"
        as_dict(as_dict(task["metadata"])[EXTENSION_URI])["outputRepresentationId"] = "unknown"
        as_dict(as_dict(primary(task)["metadata"])[EXTENSION_URI])["representationId"] = "unknown"
        with pytest.raises(ContractError):
            await client.invoke(invocation)
        as_dict(as_dict(task["metadata"])[EXTENSION_URI])["outputRepresentationId"] = "json2"
        as_dict(as_dict(primary(task)["metadata"])[EXTENSION_URI])["representationId"] = "json2"
        with pytest.raises(ContractError, match="INVALID_METADATA"):
            client.prepare(
                ID,
                input={},
                allow_server_selection=True,
                accepted_output_representation_ids=["json"],
            )
        with pytest.raises(ContractError):
            await client.invoke(
                client.prepare(ID, input={}, accepted_output_representation_ids=["json"])
            )
