"""Original values are guarded independently of SDK/provider object coercion."""

import copy
import math
import pickle
from dataclasses import FrozenInstanceError
from typing import cast

import pytest

from a2a_schema_contract.core import (
    MISSING,
    ContractError,
    ErrorContext,
    JsonValue,
    Limits,
    absolute_uri,
    loads,
    snapshot,
    versioned_id,
)


@pytest.mark.parametrize("value", [None, True, False, 0, 1.5, "", "😀", [], {}, {"a": [None]}])
def test_json_preserved(value: object) -> None:
    assert snapshot(value) == value


def test_caller_data_detached() -> None:
    original = {"values": [1]}
    result = snapshot(original)
    original["values"].append(2)
    assert result == {"values": [1]}


@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf, 2**53, -(2**53), 1e20])
def test_nonportable_numbers(value: object) -> None:
    with pytest.raises(ContractError, match="UNSUPPORTED_NUMBER"):
        snapshot(value)


@pytest.mark.parametrize("value", [object(), (1,), {1: "a"}, {"x": MISSING}, "\ud800"])
def test_non_json_values(value: object) -> None:
    with pytest.raises(ContractError, match="NON_JSON_VALUE"):
        snapshot(value)


def test_subclass_hooks_not_called() -> None:
    class Hostile(dict[str, object]):
        def items(self) -> object:  # type: ignore[override]
            raise AssertionError("must never run")

    with pytest.raises(ContractError, match="NON_JSON_VALUE"):
        snapshot(Hostile())


def test_cycle_rejected_but_alias_allowed() -> None:
    cycle: list[object] = []
    cycle.append(cycle)
    with pytest.raises(ContractError, match="NON_JSON_VALUE"):
        snapshot(cycle)
    child: list[JsonValue] = [1]
    assert snapshot([child, child]) == [[1], [1]]


@pytest.mark.parametrize(
    ("value", "limits"),
    [
        ([[]], Limits(depth=0)),
        ([1, 2], Limits(nodes=2)),
        ("abc", Limits(string=2)),
        ({"abc": 1}, Limits(bytes=8)),
        ([1], Limits(nodes=0)),
        ({"x": 1}, Limits(nodes=0)),
    ],
)
def test_bounded_json(value: object, limits: Limits) -> None:
    with pytest.raises(ContractError, match="RESOURCE_LIMIT"):
        snapshot(value, limits=limits)


@pytest.mark.parametrize(
    ("value", "limits"),
    [
        ([1, 2, 3], Limits(nodes=2)),
        ({"a": 1, "b": 2, "c": 3}, Limits(nodes=2)),
        ("abc", Limits(bytes=8)),
    ],
)
def test_container_and_final_encoded_byte_limits(value: object, limits: Limits) -> None:
    with pytest.raises(ContractError, match="RESOURCE_LIMIT"):
        snapshot(value, limits=limits)


@pytest.mark.parametrize("text", ['{"x":1,"x":2}', "[", b"\xff", '"\ud800"'])
def test_strict_json_text(text: str | bytes) -> None:
    with pytest.raises(ContractError):
        loads(text)


def test_json_text_limits_and_nonfinite() -> None:
    assert loads('{"x":null}') == {"x": None}
    with pytest.raises(ContractError, match="RESOURCE_LIMIT"):
        loads(" " * 262145)
    with pytest.raises(ContractError, match="UNSUPPORTED_NUMBER"):
        loads("NaN")


def test_missing_is_stable_and_not_null() -> None:
    assert MISSING is not None
    assert copy.deepcopy(MISSING) is MISSING
    assert pickle.loads(pickle.dumps(MISSING)) is MISSING


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("urn:example:contract:1", True),
        ("https://example.org/v1.2", True),
        ("https://example.org/latest/1", False),
        ("https://example.org/no-version", False),
        ("https://user:pass@example.org/1", False),
        ("relative/1", False),
        ("urn:é:1", False),
        ("https://example.org/%ZZ/1", False),
        ("https://[/1", False),
    ],
)
def test_identifiers(value: str, expected: bool) -> None:
    assert versioned_id(value) == expected


def test_absolute_uri() -> None:
    assert absolute_uri("urn:example:value")
    assert not absolute_uri("urn:space here")


def test_error_is_sanitized_and_context_immutable() -> None:
    context = ErrorContext("remote", "urn:example:1", "input", "json")
    error = ContractError("UNSUPPORTED_DIALECT", context)
    assert error.origin == "remote"
    assert error.detail is not None
    assert error.detail.code == "SCHEMA_INVALID"
    assert error.detail.representation_id == "json"
    with pytest.raises(FrozenInstanceError):
        context.origin = "local"  # type: ignore[misc]
    assert ContractError("INVALID_STRUCTURE").detail is None


@pytest.mark.parametrize(
    ("diagnostic", "draft"),
    [
        ("CONTRACT_NOT_FOUND", "CONTRACT_NOT_FOUND"),
        ("PAYLOAD_PRESENCE_VIOLATION", "PAYLOAD_PRESENCE_VIOLATION"),
        ("RESOLUTION_POLICY", "SCHEMA_UNAVAILABLE"),
        ("UNSUPPORTED_CARRIER", "REPRESENTATION_NOT_SUPPORTED"),
        ("NON_JSON_VALUE", "INSTANCE_INVALID"),
    ],
)
def test_draft_error_mapping(diagnostic: str, draft: str) -> None:
    from a2a_schema_contract.core import DiagnosticCode

    error = ContractError(
        cast("DiagnosticCode", diagnostic),
        ErrorContext(contract_id="urn:example:1", direction="input"),
    )
    assert error.detail is not None and error.detail.code == draft
