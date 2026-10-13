"""Immutable allowlisted hooks; host telemetry is optional and owns its destinations."""

import contextlib
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from a2a_schema_contract.core.errors import DiagnosticCode


@dataclass(frozen=True, slots=True)
class Diagnostic:
    operation: str
    correlation_id: str
    duration_ms: float
    outcome: Literal["accepted", "rejected", "aborted"]
    code: DiagnosticCode | None = None


DiagnosticHook = Callable[[Diagnostic], None]


def observe(hook: DiagnosticHook | None, event: Diagnostic) -> None:
    if hook is not None:
        with contextlib.suppress(Exception):
            hook(event)
