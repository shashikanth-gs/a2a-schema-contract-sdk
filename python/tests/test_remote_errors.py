"""Official typed rejections retain only recognized, request-correlated contract detail."""

import json

import httpx
import pytest
from a2a.client.errors import A2AClientError
from a2a.utils.errors import InvalidParamsError

from a2a_schema_contract.adapters.errors import remote_errors
from a2a_schema_contract.core import EXTENSION_URI, ContractError

from .inline_support import ID


@pytest.mark.parametrize(
    "kind", ["valid", "missing", "invalid-json", "wrong-contract", "extra", "not-string"]
)
def test_vendor_rejections_are_sanitized(kind: str) -> None:
    detail: dict[str, object] = {"code": "INSTANCE_INVALID", "contractId": ID, "direction": "input"}
    if kind == "wrong-contract":
        detail["contractId"] = "urn:other:1"
    elif kind == "extra":
        detail["secret"] = "private-peer-secret"
    raw: object = json.dumps(detail)
    if kind == "invalid-json":
        raw = "private-peer-secret"
    elif kind == "not-string":
        raw = detail
    data = {EXTENSION_URI: raw} if kind != "missing" else None
    with pytest.raises(InvalidParamsError) as caught, remote_errors(ID):
        raise InvalidParamsError(message="private-peer-secret", data=data)
    assert "private-peer-secret" not in str(caught.value)
    assert bool(caught.value.data) == (kind == "valid")


@pytest.mark.parametrize(
    "error", [A2AClientError("private-peer-secret"), httpx.ConnectError("private-peer-secret")]
)
def test_transport_failure_is_sanitized(error: Exception) -> None:
    with pytest.raises(ContractError, match="SCHEMA_UNAVAILABLE") as caught, remote_errors():
        raise error
    assert caught.value.origin == "remote"
    assert "private-peer-secret" not in str(caught.value)
