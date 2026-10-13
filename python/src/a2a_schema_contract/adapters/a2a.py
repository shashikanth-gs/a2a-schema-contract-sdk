"""Strict Part boundary for the pinned public a2a-sdk 1.2.2 protobuf carrier."""

import base64
import binascii

from a2a.types import Part
from google.protobuf.json_format import MessageToDict, ParseDict, ParseError

from a2a_schema_contract.core import ContractError, ErrorContext, JsonValue, absolute_uri, snapshot
from a2a_schema_contract.core.errors import LOCAL_CONTEXT


def part_from_wire(value: object, context: ErrorContext = LOCAL_CONTEXT) -> Part:
    """Guard original wire data before protobuf can coerce, discard, or normalize it."""
    copy = snapshot(value, context)
    if not isinstance(copy, dict):
        raise ContractError("INVALID_CARRIER", context)
    carriers = {"text", "data", "raw", "url"} & copy.keys()
    if len(carriers) != 1 or copy.keys() - {
        "text",
        "data",
        "raw",
        "url",
        "mediaType",
        "filename",
        "metadata",
    }:
        raise ContractError("INVALID_CARRIER", context)
    for key in ("text", "raw", "url", "mediaType", "filename"):
        if key in copy and not isinstance(copy[key], str):
            raise ContractError("INVALID_CARRIER", context)
    if "metadata" in copy and not isinstance(copy["metadata"], dict):
        raise ContractError("INVALID_METADATA", context)
    raw = copy.get("raw")
    if isinstance(raw, str):
        try:
            decoded = base64.b64decode(raw, validate=True)
        except binascii.Error:
            raise ContractError("INVALID_CARRIER", context) from None
        if base64.b64encode(decoded).decode("ascii") != raw:
            raise ContractError("INVALID_CARRIER", context)
    url = copy.get("url")
    if isinstance(url, str) and not absolute_uri(url):
        raise ContractError("INVALID_CARRIER", context)
    try:
        return ParseDict(copy, Part())
    except (ParseError, TypeError, ValueError):
        raise ContractError("INVALID_CARRIER", context) from None


def part_to_wire(part: Part, context: ErrorContext = LOCAL_CONTEXT) -> dict[str, JsonValue]:
    """Detach proto objects; keep oneof empty strings, scalar data, and present null."""
    copy = snapshot(MessageToDict(part), context)
    if not isinstance(copy, dict):
        raise ContractError("INVALID_CARRIER", context)
    part_from_wire(copy, context)
    return copy
