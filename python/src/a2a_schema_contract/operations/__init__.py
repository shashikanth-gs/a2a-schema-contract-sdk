"""Bounded async validation sessions. Each job owns and reaps a fresh process."""

import asyncio
import json
import time
from dataclasses import dataclass, replace
from typing import Literal, cast, get_args
from uuid import uuid4

from a2a_schema_contract.catalog import ContractCatalog
from a2a_schema_contract.core import (
    LIMITS,
    ContractError,
    Direction,
    ErrorContext,
    JsonValue,
    Origin,
    snapshot,
)
from a2a_schema_contract.core.errors import LOCAL_CONTEXT, DiagnosticCode

from .diagnostics import Diagnostic, DiagnosticHook, observe
from .process import PACKET_BYTES, encode, exchange
from .program import catalog_packet

Operation = Literal["compile", "validate", "capabilities", "request", "result", "events"]


@dataclass(frozen=True, slots=True)
class ValidationOptions:
    deadline: float = 2.0
    concurrent: int = 4

    def __post_init__(self) -> None:
        if type(self.deadline) not in (int, float) or not 0 < self.deadline <= 2:
            raise ValueError("Invalid validation deadline.")
        if type(self.concurrent) is not int or not 1 <= self.concurrent <= 4:
            raise ValueError("Invalid validation concurrency.")


DEFAULT_VALIDATION = ValidationOptions()
_ARGUMENT_LIMITS = replace(LIMITS, depth=40, nodes=131072, bytes=PACKET_BYTES)
_OPERATIONS = frozenset({"compile", "validate", "capabilities", "request", "result", "events"})


class ValidationSession:
    def __init__(
        self,
        catalog: ContractCatalog | None = None,
        *,
        options: ValidationOptions = DEFAULT_VALIDATION,
        diagnostics: DiagnosticHook | None = None,
    ) -> None:
        self.catalog, self.options, self.diagnostics = catalog, options, diagnostics
        self._jobs: set[asyncio.Task[object]] = set()
        self._closed = False

    async def run(
        self,
        operation: Operation,
        arguments: dict[str, JsonValue],
        *,
        context: ErrorContext = LOCAL_CONTEXT,
    ) -> JsonValue:
        started = time.monotonic()
        correlation = str(uuid4())
        code: DiagnosticCode | None = None
        outcome: Literal["accepted", "rejected", "aborted"] = "accepted"
        task = asyncio.current_task()
        assert task is not None
        admitted = False
        try:
            if self._closed:
                raise ContractError("VALIDATION_ABORTED", context)
            if len(self._jobs) >= self.options.concurrent:
                raise ContractError("RESOURCE_LIMIT", context)
            self._jobs.add(task)
            admitted = True
            if operation not in _OPERATIONS:
                raise ContractError("INVALID_STRUCTURE", context)
            async with asyncio.timeout(self.options.deadline):
                packet: dict[str, JsonValue] = {
                    "operation": operation,
                    "arguments": snapshot(arguments, context, limits=_ARGUMENT_LIMITS),
                    "context": {
                        "origin": context.origin,
                        "contractId": context.contract_id,
                        "direction": context.direction,
                        "representationId": context.representation_id,
                    },
                }
                if self.catalog is not None:
                    packet["catalog"] = catalog_packet(self.catalog)
                raw = await exchange(encode(packet))
                result = cast("dict[str, JsonValue]", json.loads(raw))
                if time.monotonic() - started > self.options.deadline:
                    raise ContractError("VALIDATION_TIMEOUT", context)
                if "code" in result:
                    if result["code"] not in get_args(DiagnosticCode):
                        raise ContractError("SCHEMA_INVALID", context)
                    raise ContractError(
                        cast("DiagnosticCode", result["code"]),
                        ErrorContext(
                            cast("Origin", result.get("origin", context.origin)),
                            cast("str | None", result.get("contractId", context.contract_id)),
                            cast("Direction | None", result.get("direction", context.direction)),
                            cast(
                                "str | None",
                                result.get("representationId", context.representation_id),
                            ),
                        ),
                    )
                return result["value"]
        except TimeoutError:
            code, outcome = "VALIDATION_TIMEOUT", "rejected"
            raise ContractError(code, context) from None
        except asyncio.CancelledError:
            code, outcome = "VALIDATION_ABORTED", "aborted"
            raise
        except ContractError as error:
            code, outcome = error.code, "rejected"
            raise
        except Exception:
            code, outcome = "SCHEMA_INVALID", "rejected"
            raise ContractError(code, context) from None
        finally:
            if admitted:
                self._jobs.discard(task)
            observe(
                self.diagnostics,
                Diagnostic(
                    operation if operation in _OPERATIONS else "validation",
                    correlation,
                    (time.monotonic() - started) * 1000,
                    outcome,
                    code,
                ),
            )

    async def close(self) -> None:
        self._closed = True
        jobs = tuple(self._jobs - {asyncio.current_task()})
        for task in jobs:
            task.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)

    async def __aenter__(self) -> "ValidationSession":
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()


__all__ = ["Diagnostic", "DiagnosticHook", "ValidationOptions", "ValidationSession"]
