"""Shared semantic cases and adversarial schema preparation, independent of Node."""

import json
from pathlib import Path
from typing import cast

import pytest

from a2a_schema_contract.core import JSON_SCHEMA_DIALECT, ContractError, JsonValue
from a2a_schema_contract.ports import ValidationEngine
from a2a_schema_contract.validation import JsonSchemaEngine, validate_structure, validate_value

ENGINE: ValidationEngine = JsonSchemaEngine()
CASES = cast(
    "list[dict[str, object]]",
    json.loads(
        (Path(__file__).parent / "fixtures" / "inline-core-cases.json").read_text(encoding="utf-8"),
    )["cases"],
)


@pytest.mark.parametrize(
    "case",
    [case for case in CASES if case["operation"] == "validate"],
    ids=lambda case: str(case["id"]),
)
def test_shared_cases(case: dict[str, object]) -> None:
    expected = cast("dict[str, object]", case["expected"])
    before = json.dumps(case["value"], sort_keys=True)
    if expected["accepted"]:
        assert (
            validate_value(
                case["value"],
                schema=case["schema"],
                media_type=str(case.get("mediaType", "application/json")),
            )
            == case["value"]
        )
    else:
        with pytest.raises(ContractError) as caught:
            validate_value(
                case["value"],
                schema=case["schema"],
                media_type=str(case.get("mediaType", "application/json")),
            )
        assert caught.value.code == expected["diagnostic"]
        assert "never-in-errors" not in str(caught.value)
    assert json.dumps(case["value"], sort_keys=True) == before


@pytest.mark.parametrize("value", [True, False, "1", None])
def test_integer_does_not_coerce(value: object) -> None:
    with pytest.raises(ContractError, match="INSTANCE_INVALID"):
        ENGINE.compile({"type": "integer"}).validate(value)


def test_numeric_proto_equivalence() -> None:
    assert ENGINE.compile({"type": "integer"}).validate(1.0) == 1
    assert ENGINE.compile({"type": "boolean"}).validate(True) is True


@pytest.mark.parametrize(
    ("schema", "diagnostic"),
    [
        (None, "SCHEMA_INVALID"),
        ({"type": 1}, "SCHEMA_INVALID"),
        ({"$id": "bad uri"}, "SCHEMA_INVALID"),
        ({"$id": 1}, "SCHEMA_INVALID"),
        ({"$vocabulary": []}, "SCHEMA_INVALID"),
        ({"$vocabulary": {"relative": True}}, "SCHEMA_INVALID"),
        ({"$vocabulary": {"https://example.org/vocab": 1}}, "SCHEMA_INVALID"),
        (
            {"$vocabulary": {"https://json-schema.org/draft/2020-12/vocab/core": False}},
            "UNSUPPORTED_VOCABULARY",
        ),
        ({"properties": []}, "SCHEMA_INVALID"),
        ({"allOf": {}}, "SCHEMA_INVALID"),
        ({"properties": {"__proto__": False}}, "UNSUPPORTED_KEYWORD"),
        ({"$ref": "#"}, "SCHEMA_INVALID"),
        ({"$dynamicRef": "https://example.org/schema"}, "SCHEMA_UNAVAILABLE"),
        ({"multipleOf": True}, "UNSUPPORTED_NUMBER"),
        ({"multipleOf": 0}, "UNSUPPORTED_NUMBER"),
        ({"multipleOf": "1"}, "UNSUPPORTED_NUMBER"),
        ({"properties": {str(i): True for i in range(256)}}, "RESOURCE_LIMIT"),
        ({"properties": {str(i): {"$ref": "#"} for i in range(129)}}, "RESOURCE_LIMIT"),
    ],
)
def test_schema_rejections(schema: object, diagnostic: str) -> None:
    with pytest.raises(ContractError, match=diagnostic):
        ENGINE.compile(schema)


@pytest.mark.parametrize(
    "pattern",
    [
        "a" * 129,
        "é",
        "a^",
        "$a",
        "[]",
        "[^]",
        "[",
        r"[\d]",
        r"\d",
        r"\-",
        "\\",
        "*a",
        "a{",
        "a{8193}",
        "a{2,1}",
        "a{1,8193}",
        "a**",
        "a|b",
        "a)",
        "[z-a]",
    ],
)
def test_portable_regex_rejections(pattern: str) -> None:
    with pytest.raises(ContractError, match="UNSUPPORTED_REGEX"):
        ENGINE.compile({"pattern": pattern})


@pytest.mark.parametrize(
    ("pattern", "value"),
    [
        ("^[A-Z]{3}$", "DEL"),
        ("a{1,3}", "aa"),
        ("a{2}", "aa"),
        (r"\.", "."),
        ("a+", "aaa"),
        ("a?", ""),
        ("a{1,}", "a"),
    ],
)
def test_portable_regex_acceptance(pattern: str, value: str) -> None:
    assert ENGINE.compile({"pattern": pattern}).validate(value) == value


def test_schema_snapshot_is_detached() -> None:
    schema: dict[str, JsonValue] = {"type": "integer"}
    validator = ENGINE.compile(schema)
    schema["type"] = "string"
    assert validator.validate(1) == 1


def test_recursive_local_refs() -> None:
    schema = {
        "$id": "https://example.org/tree/1",
        "type": "object",
        "properties": {"children": {"type": "array", "items": {"$ref": "#"}}},
    }
    assert ENGINE.compile(schema).validate({"children": [{}]}) == {"children": [{}]}


def test_declared_dialect_and_annotation() -> None:
    assert ENGINE.compile({"$schema": JSON_SCHEMA_DIALECT, "format": "email"}).validate("x") == "x"


def test_pinned_structures() -> None:
    value = {
        "contractId": "urn:example:1",
        "direction": "input",
        "representationId": "json",
        "role": "primary",
    }
    assert validate_structure("part-metadata", value) == value
    with pytest.raises(ContractError, match="INVALID_STRUCTURE"):
        validate_structure("part-metadata", {**value, "unexpected": 1})
