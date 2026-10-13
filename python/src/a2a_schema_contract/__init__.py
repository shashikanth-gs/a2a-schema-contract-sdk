"""Schema Contract SDK; core imports load no official SDK, transport, or framework."""

from .core import (
    A2A_PROTOCOL_VERSION,
    EXTENSION_URI,
    JSON_SCHEMA_DIALECT,
    MISSING,
    ContractError,
    ErrorContext,
    ErrorDetail,
    JsonValue,
    Missing,
)

__version__ = "0.1.0.dev0"
__all__ = [
    "A2A_PROTOCOL_VERSION",
    "EXTENSION_URI",
    "JSON_SCHEMA_DIALECT",
    "MISSING",
    "ContractError",
    "ErrorContext",
    "ErrorDetail",
    "JsonValue",
    "Missing",
    "__version__",
]
