"""Execute the unchanged shared Node binding fixtures through the Python client."""

import hashlib
import json
from pathlib import Path
from typing import cast

import httpx
import pytest

from a2a_schema_contract.client import ContractClient
from a2a_schema_contract.core import JsonValue

from .inline_support import as_dict, catalog
from .test_inline_peers import mock_peer

FIXTURES = Path(__file__).parent / "fixtures"


def test_shared_fixture_hashes() -> None:
    manifest = json.loads((FIXTURES / "binding-manifest.json").read_text())
    for name, digest in manifest["files"].items():
        assert hashlib.sha256((FIXTURES / name).read_bytes()).hexdigest() == digest


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["response", "failure"])
async def test_shared_binding_http_client(outcome: str) -> None:
    request_fixture = json.loads((FIXTURES / "binding-request.json").read_text())
    response_fixture = json.loads((FIXTURES / f"binding-{outcome}.json").read_text())
    raw = catalog()
    identifier = "urn:example:flight-search:1"
    as_dict(cast("list[JsonValue]", raw["contracts"])[0])["id"] = identifier

    def reply(request: dict[str, JsonValue]) -> httpx.Response:
        assert request["params"] == request_fixture["params"]
        return httpx.Response(200, json={**response_fixture, "id": request["id"]})

    async with (
        mock_peer(reply, raw) as http,
        await ContractClient.discover("http://peer.test", http_client=http) as client,
    ):
        prepared = client.prepare(identifier, input={"origin": "BLR"}, message_id="binding-input-1")
        result = await client.invoke(prepared)
        expected = dict(response_fixture["result"]["task"])
        # Protobuf omits empty repeated fields; the shared no-artifact outcome is unchanged.
        if expected.get("artifacts") == []:
            del expected["artifacts"]
        assert result.response.value == expected
        if outcome == "response":
            assert (
                result.payload
                and result.payload.present
                and result.payload.value == {"origin": "BLR"}
            )
        else:
            assert result.payload is None
