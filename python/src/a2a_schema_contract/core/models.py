"""Immutable protocol-independent catalog and prepared resource values."""

import json
from dataclasses import dataclass
from typing import Literal

from .errors import LOCAL_CONTEXT, ContractError, DiagnosticCode, ErrorContext
from .json import snapshot
from .types import Direction, JsonValue, Presence


@dataclass(frozen=True, slots=True, init=False)
class JsonDocument:
    """Private immutable JSON snapshot; inspection always returns independent builtins."""

    _encoded: str

    def __init__(self, value: object, context: ErrorContext = LOCAL_CONTEXT) -> None:
        object.__setattr__(
            self, "_encoded", json.dumps(snapshot(value, context), ensure_ascii=False)
        )

    @property
    def value(self) -> JsonValue:
        return snapshot(json.loads(self._encoded))


@dataclass(frozen=True, slots=True)
class Representation:
    id: str
    media_type: str
    description: str | None
    schema: JsonDocument | None


@dataclass(frozen=True, slots=True)
class ContractDirection:
    presence: Presence
    representations: tuple[Representation, ...]


@dataclass(frozen=True, slots=True)
class Contract:
    id: str
    input: ContractDirection
    output: ContractDirection
    description: str | None
    skill_ids: tuple[str, ...]
    supersedes: tuple[str, ...]

    def direction(self, direction: Direction) -> ContractDirection:
        if type(direction) is not str or direction not in ("input", "output"):
            raise ContractError("INVALID_STRUCTURE")
        return self.input if direction == "input" else self.output


@dataclass(frozen=True, slots=True)
class SchemaResource:
    uri: str
    document: JsonDocument
    aliases: tuple[str, ...] = ()

    @property
    def value(self) -> JsonValue:
        return self.document.value


@dataclass(frozen=True, slots=True)
class PreparedSchema:
    entry: str
    descriptor: JsonDocument
    documents: tuple[SchemaResource, ...]


@dataclass(frozen=True, slots=True)
class Capability:
    representation: Representation
    supported: bool
    diagnostic: DiagnosticCode | None = None


@dataclass(frozen=True, slots=True)
class AbsentPayload:
    present: Literal[False] = False


@dataclass(frozen=True, slots=True)
class PresentPayload:
    document: JsonDocument
    representation_id: str
    part: JsonDocument
    present: Literal[True] = True

    @property
    def value(self) -> JsonValue:
        return self.document.value


Payload = PresentPayload | AbsentPayload


@dataclass(frozen=True, slots=True)
class Invocation:
    contract_id: str
    input_representation_id: str | None
    accepted_output_representation_ids: tuple[str, ...] | None


@dataclass(frozen=True, slots=True)
class InvocationSelection:
    invocation: Invocation
    input: Payload
