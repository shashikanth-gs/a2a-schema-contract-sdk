"""Sanitize vendor/peer errors while preserving official typed A2A rejection classes."""

import json
from collections.abc import Iterator
from contextlib import contextmanager

import httpx
from a2a.client.errors import A2AClientError
from a2a.utils.errors import A2AError

from ..core import EXTENSION_URI, ContractError, ErrorContext, loads
from ..validation import validate_structure


@contextmanager
def remote_errors(contract_id: str | None = None) -> Iterator[None]:
    try:
        yield
    except (A2AClientError, httpx.HTTPError):
        raise ContractError("SCHEMA_UNAVAILABLE", ErrorContext("remote")) from None
    except A2AError as error:
        data = None
        if contract_id is not None and isinstance(error.data, dict):
            raw = error.data.get(EXTENSION_URI)
            if isinstance(raw, str):
                try:
                    detail = validate_structure("error-detail", loads(raw, ErrorContext("remote")))
                    if isinstance(detail, dict) and detail.get("contractId") == contract_id:
                        data = {EXTENSION_URI: json.dumps(detail)}
                except ContractError:
                    pass
        raise type(error)(message="A2A request rejected.", data=data) from None
