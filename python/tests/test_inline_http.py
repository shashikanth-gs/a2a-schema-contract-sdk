"""Acceptance over real HTTP/SSE using the published official Python A2A SDK."""

import asyncio
import json
from typing import Literal, cast

import httpx
import pytest
from a2a.utils.errors import InvalidParamsError

from a2a_schema_contract.client import ContractClient
from a2a_schema_contract.core import EXTENSION_URI, MISSING, ContractError, JsonValue

from .inline_support import ID, EchoExecutor, as_dict, catalog, provider


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "value", [None, False, 0, 1.5, "", "😀", [], {}, {"nested": None}, [0, None]]
)
async def test_real_http_preserves_json_values(value: JsonValue) -> None:
    async with (
        provider() as (base, server, executor),
        await ContractClient.discover(base) as client,
    ):
        description = client.describe()
        assert description.skills[0].contracts[0].contract.id == ID
        assert client.bind_skill("echo").id == ID
        result = await client.invoke(client.prepare(ID, input=value))
        assert result.payload is not None and result.payload.present
        assert result.payload.value == value
        assert executor.calls == 1
        assert not server._active


@pytest.mark.asyncio
@pytest.mark.parametrize("input_presence", ["required", "optional", "none"])
@pytest.mark.parametrize("output_presence", ["required", "optional", "none"])
async def test_real_http_all_presence_combinations(
    input_presence: str, output_presence: str
) -> None:
    raw = catalog(
        cast("Literal['required', 'optional', 'none']", input_presence),
        cast("Literal['required', 'optional', 'none']", output_presence),
    )
    async with provider(raw) as (base, _, executor), await ContractClient.discover(base) as client:
        invocation = client.prepare(ID, input=MISSING if input_presence == "none" else {})
        result = await client.invoke(invocation)
        assert result.payload is not None
        assert result.payload.present == (output_presence != "none")
        assert executor.calls == 1


@pytest.mark.asyncio
async def test_real_sse_atomic_result_and_early_progress() -> None:
    executor = EchoExecutor(pause=0.05)
    async with (
        provider(executor=executor) as (base, _, _),
        await ContractClient.discover(base) as client,
    ):
        stream = client.stream(client.prepare(ID, input={"value": 7}))
        first = await anext(stream)
        assert first.result is None
        assert not as_dict(as_dict(first.event.value)["data"]).get("artifacts")
        second = await anext(stream)
        assert second.result and second.result.payload and second.result.payload.present
        assert second.result.payload.value == {"value": 7}
        with pytest.raises(StopAsyncIteration):
            await anext(stream)


@pytest.mark.asyncio
async def test_invalid_input_never_executes_client_or_raw_peer() -> None:
    async with (
        provider(catalog(schema={"type": "integer"})) as (base, _, executor),
        await ContractClient.discover(base) as client,
    ):
        with pytest.raises(ContractError):
            client.prepare(ID, input="secret")
        request = as_dict(client.prepare(ID, input=1).request.value)
        parts = cast("list[JsonValue]", as_dict(request["message"])["parts"])
        as_dict(parts[0])["data"] = "secret"
        async with httpx.AsyncClient() as http:
            response = await http.post(
                base + "/a2a",
                json={
                    "jsonrpc": "2.0",
                    "id": "invalid",
                    "method": "SendMessage",
                    "params": request,
                },
                headers={"A2A-Extensions": EXTENSION_URI, "A2A-Version": "1.0"},
            )
        body = response.json()
        assert "error" in body
        detail = json.loads(body["error"]["data"][0]["metadata"][EXTENSION_URI])
        assert detail["code"] == "INSTANCE_INVALID" and detail["contractId"] == ID
        assert "secret" not in response.text
        assert executor.calls == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("streaming", [False, True])
async def test_invalid_output_is_failed_without_business_artifacts(streaming: bool) -> None:
    async with (
        provider(catalog(schema={"type": "integer"}), executor=EchoExecutor(output="secret")) as (
            base,
            _,
            executor,
        ),
        await ContractClient.discover(base) as client,
    ):
        invocation = client.prepare(ID, input=1)
        if streaming:
            events = [event async for event in client.stream(invocation)]
            result = events[-1].result
            assert result is not None
        else:
            result = await client.invoke(invocation)
        task = as_dict(result.response.value)
        assert as_dict(task["status"])["state"] == "TASK_STATE_FAILED"
        assert not task.get("artifacts")
        assert result.payload is None
        assert "secret" not in json.dumps(task)
        assert executor.calls == 1


@pytest.mark.asyncio
async def test_borrowed_http_client_remains_open_and_headers_reach_host() -> None:
    async with provider() as (base, _, _):
        requests: list[httpx.Request] = []

        async def observe(request: httpx.Request) -> None:
            requests.append(request)

        async with httpx.AsyncClient(
            headers={"Authorization": "Bearer test-only"}, event_hooks={"request": [observe]}
        ) as http:
            client = await ContractClient.discover(
                base, http_client=http, headers={"A2A-Extensions": "urn:example:other:1"}
            )
            await client.invoke(client.prepare(ID, input={}))
            await client.close()
            await client.close()
            assert not http.is_closed
            assert requests[-1].headers["Authorization"] == "Bearer test-only"
            assert EXTENSION_URI in requests[-1].headers["A2A-Extensions"]
            assert "urn:example:other:1" in requests[-1].headers["A2A-Extensions"]
            with pytest.raises(ContractError):
                client.prepare(ID, input={})


@pytest.mark.asyncio
async def test_execution_deadline_finishes_without_output() -> None:
    async with (
        provider(executor=EchoExecutor(pause=1), deadline=0.05) as (base, server, _),
        await ContractClient.discover(base) as client,
    ):
        result = await asyncio.wait_for(client.invoke(client.prepare(ID, input={})), 2)
        assert as_dict(as_dict(result.response.value)["status"])["state"] == "TASK_STATE_FAILED"
        assert not server._active


@pytest.mark.asyncio
async def test_wire_tenant_claim_cannot_select_authority() -> None:
    async with provider() as (base, _, executor), await ContractClient.discover(base) as client:
        with pytest.raises(InvalidParamsError):
            await client.invoke(client.prepare(ID, input={}, tenant="foreign"))
        assert executor.calls == 0
