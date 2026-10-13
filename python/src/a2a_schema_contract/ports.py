"""Inward-facing validation interfaces; infrastructure stays outside domain types."""

from typing import Protocol

from .core import ErrorContext, JsonValue
from .core.errors import LOCAL_CONTEXT


class SchemaValidator(Protocol):
    """Validate without mutating or coercing caller data."""

    def validate(self, value: object, context: ErrorContext = LOCAL_CONTEXT) -> JsonValue: ...


class ValidationEngine(Protocol):
    """Vetted implementations only; applications use the supplied default engine."""

    def compile(
        self,
        schema: object,
        context: ErrorContext = LOCAL_CONTEXT,
    ) -> SchemaValidator: ...
