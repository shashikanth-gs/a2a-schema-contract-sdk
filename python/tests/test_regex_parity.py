"""Independent expected ECMA-262 outcomes, including referenced schema-map locations."""

import pytest

from a2a_schema_contract.core import ContractError
from a2a_schema_contract.validation import JsonSchemaEngine

ENGINE = JsonSchemaEngine()


@pytest.mark.parametrize(
    ("pattern", "value"),
    [
        ("a$", "a\n"),
        ("a$", "a\r"),
        ("a$", "a\u2028"),
        ("a$", "a\u2029"),
    ],
)
def test_ecma_line_separator_rejections(pattern: str, value: str) -> None:
    with pytest.raises(ContractError, match="INSTANCE_INVALID"):
        ENGINE.compile({"pattern": pattern}).validate(value)


@pytest.mark.parametrize(("pattern", "value"), [(r"\.$", "."), ("[.$]", "$"), ("[.$]", ".")])
def test_literals_and_classes_unchanged(pattern: str, value: str) -> None:
    assert ENGINE.compile({"pattern": pattern}).validate(value) == value


@pytest.mark.parametrize("keyword", ["additionalProperties", "unevaluatedProperties"])
def test_pattern_property_annotations_and_remaining_properties(keyword: str) -> None:
    validator = ENGINE.compile(
        {
            "type": "object",
            "patternProperties": {"^a$": {"type": "integer"}},
            keyword: False,
        }
    )
    assert validator.validate({"a": 1}) == {"a": 1}
    with pytest.raises(ContractError, match="INSTANCE_INVALID"):
        validator.validate({"a\n": 1})


@pytest.mark.parametrize(
    "schema",
    [
        {
            "$defs": {"source": {"patternProperties": {"^a$": {"type": "integer"}}}},
            "$ref": "#/$defs/source/patternProperties/^a$",
        },
        {
            "$id": "https://example.org/root/1",
            "$defs": {
                "source": {"$id": "child", "patternProperties": {"^a$": {"type": "integer"}}}
            },
            "$ref": "child#/patternProperties/^a$",
        },
        {
            "$id": "https://example.org/root/1",
            "$defs": {
                "source": {"$id": "child", "patternProperties": {"^a$": {"type": "integer"}}}
            },
            "$ref": "#/$defs/source/patternProperties/%5Ea%24",
        },
        {"patternProperties": {"^a$": True}, "$ref": "#/patternProperties/^a$"},
    ],
)
def test_pointer_references_survive_private_pattern_projection(schema: object) -> None:
    validator = ENGINE.compile(schema)
    assert validator.validate(1) == 1


def test_dynamic_anchor_recursive_schema() -> None:
    schema = {
        "$dynamicAnchor": "node",
        "type": "object",
        "properties": {
            "children": {"type": "array", "items": {"$dynamicRef": "#node"}},
            "name": {"type": "string", "pattern": "^[a-z]$"},
        },
    }
    validator = ENGINE.compile(schema)
    assert validator.validate({"name": "a", "children": [{"name": "b"}]})
    with pytest.raises(ContractError, match="INSTANCE_INVALID"):
        validator.validate({"children": [{"name": "b\n"}]})
