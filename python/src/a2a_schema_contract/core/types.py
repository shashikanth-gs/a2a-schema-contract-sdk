"""Protocol-independent value types. No transport or framework imports."""

from dataclasses import dataclass
from enum import Enum
from typing import Literal, TypeAlias

JsonValue: TypeAlias = bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"] | None
Origin: TypeAlias = Literal["local", "remote"]
Direction: TypeAlias = Literal["input", "output"]
Presence: TypeAlias = Literal["required", "optional", "none"]


class Missing(Enum):
    """Explicit absence, distinct from JSON null; stable across copying and pickling."""

    VALUE = "missing"


MISSING = Missing.VALUE


@dataclass(frozen=True, slots=True)
class Limits:
    """Same bounded data profile as the accepted Node implementation."""

    depth: int = 32
    nodes: int = 4096
    bytes: int = 262144
    string: int = 8192
    schemas: int = 256
    references: int = 128
    pattern: int = 128
    parts: int = 128


LIMITS = Limits()
EXTENSION_URI = "https://w3id.org/a2a-schema-contract/draft/0.1"
A2A_PROTOCOL_VERSION = "1.0"
JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema"
