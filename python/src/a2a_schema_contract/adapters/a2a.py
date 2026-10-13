"""Strict Part boundary for the pinned public a2a-sdk 1.2.2 protobuf carrier."""

from a2a.types import Part
from google.protobuf.json_format import MessageToDict, ParseDict, ParseError

from a2a_schema_contract.core import ContractError, ErrorContext, JsonValue, snapshot
from a2a_schema_contract.core.errors import LOCAL_CONTEXT
from a2a_schema_contract.payload import guard_part


def part_from_wire(value: object, context: ErrorContext = LOCAL_CONTEXT) -> Part:
    """Guard original wire data before protobuf can coerce, discard, or normalize it."""
    copy = guard_part(value, context, "a2a-python-1.2.2")
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
