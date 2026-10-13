"""Optional activation and retained binding rules use the same guarded routes."""

from typing import cast

import httpx
import pytest
from a2a.server.agent_execution import RequestContext
from a2a.server.events import EventQueue
from a2a.types import Message
from a2a.utils.errors import InvalidParamsError

from a2a_schema_contract.client import ContractClient
from a2a_schema_contract.core import EXTENSION_URI, JsonValue
from a2a_schema_contract.core.models import JsonDocument

from .inline_support import ID, EchoExecutor, as_dict, catalog, provider
from .test_inline_lifecycle import ContinueExecutor


class OrdinaryExecutor(EchoExecutor):
    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        if EXTENSION_URI in context.requested_extensions:
            await super().execute(context, event_queue)
            return
        self.calls += 1
        await event_queue.enqueue_event(
            Message(
                message_id="ordinary-reply",
                context_id=context.context_id,
                role="ROLE_AGENT",
                parts=[{"text": "ordinary"}],
            )
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("marker", ["operation", "message", "part"])
async def test_optional_ordinary_call_and_unactivated_markers(marker: str) -> None:
    async with (
        provider(executor=OrdinaryExecutor(), required=False) as (base, _, executor),
        httpx.AsyncClient(headers={"A2A-Version": "1.0"}) as http,
    ):
        params: dict[str, JsonValue] = {
            "message": {
                "messageId": "ordinary-request",
                "role": "ROLE_USER",
                "parts": [{"text": "trigger"}],
            }
        }
        rpc = {"jsonrpc": "2.0", "id": 1, "method": "SendMessage", "params": params}
        response = await http.post(base + "/a2a", json=rpc)
        assert response.json()["result"]["message"]["parts"] == [{"text": "ordinary"}]
        assert executor.calls == 1
        metadata: JsonValue = {EXTENSION_URI: {"contractId": ID}}
        if marker == "operation":
            params["metadata"] = metadata
        elif marker == "message":
            as_dict(params["message"])["metadata"] = metadata
        else:
            as_dict(cast("list[JsonValue]", as_dict(params["message"])["parts"])[0])["metadata"] = (
                metadata
            )
        rejected = await http.post(base + "/a2a", json=rpc)
        assert rejected.json()["error"]["code"] == -32602 and executor.calls == 1


@pytest.mark.asyncio
async def test_optional_contract_continuation_requires_activation() -> None:
    executor = ContinueExecutor()
    async with (
        provider(executor=executor, required=False) as (base, _, _),
        await ContractClient.discover(base) as client,
        httpx.AsyncClient(headers={"A2A-Version": "1.0"}) as http,
    ):
        task = as_dict((await client.invoke(client.prepare(ID, input={}))).response.value)
        response = await http.post(
            base + "/a2a",
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "SendMessage",
                "params": {
                    "message": {
                        "messageId": "unactivated-resume",
                        "role": "ROLE_USER",
                        "taskId": task["id"],
                        "contextId": task["contextId"],
                        "parts": [{"text": "resume"}],
                    }
                },
            },
        )
        assert response.json()["error"]["code"] == -32602 and executor.calls == 1


@pytest.mark.asyncio
async def test_continuation_cannot_renegotiate_selected_output() -> None:
    raw = catalog()
    contract = as_dict(cast("list[JsonValue]", raw["contracts"])[0])
    reps = cast("list[JsonValue]", as_dict(contract["output"])["representations"])
    second = as_dict(JsonDocument(reps[0]).value)
    second["id"] = "json2"
    reps.append(second)
    executor = ContinueExecutor()
    async with (
        provider(raw, executor=executor) as (base, _, _),
        await ContractClient.discover(base) as client,
    ):
        result = await client.invoke(
            client.prepare(ID, input={}, accepted_output_representation_ids=["json"])
        )
        task = as_dict(result.response.value)
        with pytest.raises(InvalidParamsError):
            await client.invoke(
                client.prepare(
                    ID,
                    input={},
                    accepted_output_representation_ids=["json2"],
                    task_id=cast("str", task["id"]),
                    context_id=cast("str", task["contextId"]),
                )
            )
        assert executor.calls == 1
