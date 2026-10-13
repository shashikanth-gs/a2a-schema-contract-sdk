"""Typed/discovered end-to-end agent calls use prepared external resources offline."""

import pytest

from a2a_schema_contract.client import ContractClient
from a2a_schema_contract.core import ContractError

from .inline_support import ID, as_dict, catalog, provider
from .resolver_support import peer, response
from .test_resolver_tls import resolver


@pytest.mark.asyncio
async def test_external_schema_real_agent_both_async_boundaries() -> None:
    async with peer() as resources:
        uri = resources.url("/schemas/v1.json")
        resources.routes["/schemas/v1.json"] = response(b'{"type":"object"}')
        value = catalog()
        contract = as_dict(value["contracts"][0])  # type: ignore[index]
        for side in ("input", "output"):
            rep = as_dict(as_dict(contract[side])["representations"][0])  # type: ignore[index]
            descriptor = as_dict(rep["schema"])
            del descriptor["inline"]
            descriptor["uri"] = uri
        async with resolver(resources, immutable_resources=(uri,)) as service:
            prepared = await service.resolve_catalog(value, origin="local")
            async with provider(prepared) as (base, _, executor):
                async with await ContractClient.discover(base, resolver=service) as client:
                    service.clear_cache()
                    count = len(resources.requests)
                    bound = client.bind_skill("echo")
                    assert bound.id == ID
                    result = await client.invoke(client.prepare(ID, input={"typed": True}))
                    assert (
                        result.payload
                        and result.payload.present
                        and result.payload.value == {"typed": True}
                    )
                    events = [
                        event
                        async for event in client.stream(
                            client.prepare(ID, input={"discovered": True})
                        )
                    ]
                    final = events[-1].result
                    assert final and final.payload and final.payload.present
                    assert final.payload.value == {"discovered": True}
                    assert len(resources.requests) == count
                    with pytest.raises(ContractError, match="INSTANCE_INVALID"):
                        client.prepare(ID, input="invalid")
                    assert executor.calls == 2
                assert not service._closed  # Borrowed resolver ownership stays with its caller.
