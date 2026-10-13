"""Sanitized diagnostics; wire errors stay inside the pinned draft vocabulary."""

from dataclasses import dataclass
from typing import Literal, TypeAlias, cast

from .types import Direction, Origin

DiagnosticCode: TypeAlias = Literal[
    "INVALID_STRUCTURE",
    "INVALID_IDENTIFIER",
    "VERSION_MISMATCH",
    "DUPLICATE_IDENTIFIER",
    "CONTRACT_NOT_FOUND",
    "AMBIGUOUS_SELECTION",
    "REPRESENTATION_NOT_SUPPORTED",
    "PAYLOAD_PRESENCE_VIOLATION",
    "PRIMARY_IDENTITY_MISMATCH",
    "INVALID_METADATA",
    "INVALID_CARRIER",
    "UNSUPPORTED_CARRIER",
    "NON_JSON_VALUE",
    "VALIDATION_TIMEOUT",
    "VALIDATION_ABORTED",
    "RESOURCE_LIMIT",
    "UNSUPPORTED_MEDIA_TYPE",
    "UNSUPPORTED_DIALECT",
    "UNSUPPORTED_VOCABULARY",
    "UNSUPPORTED_KEYWORD",
    "UNSUPPORTED_REGEX",
    "UNSUPPORTED_NUMBER",
    "RESOLUTION_POLICY",
    "INTEGRITY_MISMATCH",
    "RESOLUTION_ABORTED",
    "RESOLUTION_TIMEOUT",
    "REFERENCE_CYCLE",
    "SCHEMA_UNAVAILABLE",
    "SCHEMA_INVALID",
    "INSTANCE_INVALID",
]
DraftErrorCode: TypeAlias = Literal[
    "CONTRACT_NOT_FOUND",
    "REPRESENTATION_NOT_SUPPORTED",
    "PAYLOAD_PRESENCE_VIOLATION",
    "SCHEMA_UNAVAILABLE",
    "SCHEMA_INVALID",
    "INSTANCE_INVALID",
]


@dataclass(frozen=True, slots=True)
class ErrorContext:
    origin: Origin = "local"
    contract_id: str | None = None
    direction: Direction | None = None
    representation_id: str | None = None


LOCAL_CONTEXT = ErrorContext()


@dataclass(frozen=True, slots=True)
class ErrorDetail:
    code: DraftErrorCode
    contract_id: str
    direction: Direction
    representation_id: str | None = None


def _draft_code(code: DiagnosticCode) -> DraftErrorCode:
    if code in {"CONTRACT_NOT_FOUND", "PAYLOAD_PRESENCE_VIOLATION", "INSTANCE_INVALID"}:
        return cast("DraftErrorCode", code)
    if code in {
        "SCHEMA_UNAVAILABLE",
        "RESOLUTION_POLICY",
        "INTEGRITY_MISMATCH",
        "RESOLUTION_ABORTED",
        "RESOLUTION_TIMEOUT",
        "REFERENCE_CYCLE",
    }:
        return "SCHEMA_UNAVAILABLE"
    if code in {
        "REPRESENTATION_NOT_SUPPORTED",
        "AMBIGUOUS_SELECTION",
        "UNSUPPORTED_MEDIA_TYPE",
        "UNSUPPORTED_CARRIER",
    }:
        return "REPRESENTATION_NOT_SUPPORTED"
    if code in {
        "SCHEMA_INVALID",
        "UNSUPPORTED_DIALECT",
        "UNSUPPORTED_VOCABULARY",
        "UNSUPPORTED_KEYWORD",
        "UNSUPPORTED_REGEX",
        "UNSUPPORTED_NUMBER",
    }:
        return "SCHEMA_INVALID"
    return "INSTANCE_INVALID"


class ContractError(Exception):
    """Retains no payload, schema, validator message, URL, or raw cause."""

    def __init__(self, code: DiagnosticCode, context: ErrorContext = LOCAL_CONTEXT) -> None:
        super().__init__(f"Schema Contract rejected: {code}.")
        self.code = code
        self.origin = context.origin
        self.detail = (
            ErrorDetail(
                _draft_code(code), context.contract_id, context.direction, context.representation_id
            )
            if context.contract_id is not None and context.direction is not None
            else None
        )
