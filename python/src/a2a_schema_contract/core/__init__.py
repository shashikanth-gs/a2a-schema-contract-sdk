"""Framework-independent domain values and strict JSON boundaries."""

from .errors import ContractError, DiagnosticCode, ErrorContext, ErrorDetail
from .json import absolute_uri, loads, snapshot, versioned_id
from .types import (
    A2A_PROTOCOL_VERSION,
    EXTENSION_URI,
    JSON_SCHEMA_DIALECT,
    LIMITS,
    MISSING,
    Direction,
    JsonValue,
    Limits,
    Missing,
    Origin,
    Presence,
)

__all__ = [
    "A2A_PROTOCOL_VERSION",
    "EXTENSION_URI",
    "JSON_SCHEMA_DIALECT",
    "LIMITS",
    "MISSING",
    "ContractError",
    "DiagnosticCode",
    "Direction",
    "ErrorContext",
    "ErrorDetail",
    "JsonValue",
    "Limits",
    "Missing",
    "Origin",
    "Presence",
    "absolute_uri",
    "loads",
    "snapshot",
    "versioned_id",
]
