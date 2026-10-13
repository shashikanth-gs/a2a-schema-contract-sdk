"""Preflight the portable Node/Python JSON Schema profile before vendor validation."""

import re
from urllib.parse import urljoin

from a2a_schema_contract.core import (
    JSON_SCHEMA_DIALECT,
    LIMITS,
    ContractError,
    ErrorContext,
    JsonValue,
    absolute_uri,
)

MAP_SCHEMAS = frozenset({"$defs", "properties", "patternProperties", "dependentSchemas"})
ONE_SCHEMA = frozenset(
    {
        "additionalProperties",
        "unevaluatedProperties",
        "propertyNames",
        "items",
        "contains",
        "unevaluatedItems",
        "not",
        "if",
        "then",
        "else",
        "contentSchema",
    }
)
ARRAY_SCHEMAS = frozenset({"allOf", "anyOf", "oneOf", "prefixItems"})
KEYWORDS = (
    MAP_SCHEMAS
    | ONE_SCHEMA
    | ARRAY_SCHEMAS
    | {
        "$schema",
        "$id",
        "$anchor",
        "$dynamicAnchor",
        "$ref",
        "$dynamicRef",
        "$comment",
        "$vocabulary",
        "type",
        "enum",
        "const",
        "multipleOf",
        "maximum",
        "minimum",
        "exclusiveMaximum",
        "exclusiveMinimum",
        "maxLength",
        "minLength",
        "pattern",
        "maxItems",
        "minItems",
        "uniqueItems",
        "maxContains",
        "minContains",
        "maxProperties",
        "minProperties",
        "required",
        "dependentRequired",
        "title",
        "description",
        "default",
        "deprecated",
        "readOnly",
        "writeOnly",
        "examples",
        "format",
        "contentEncoding",
        "contentMediaType",
    }
)
VOCABULARIES = frozenset(
    f"https://json-schema.org/draft/2020-12/vocab/{name}"
    for name in (
        "core",
        "applicator",
        "validation",
        "unevaluated",
        "meta-data",
        "format-annotation",
        "content",
    )
)


def check_pattern(pattern: str, context: ErrorContext) -> None:
    """Small portable ASCII grammar; at most one variable repetition."""
    if len(pattern) > LIMITS.pattern or any(not 32 <= ord(char) <= 126 for char in pattern):
        raise ContractError("UNSUPPORTED_REGEX", context)
    variable = 0
    atom = False
    index = 0
    while index < len(pattern):
        char = pattern[index]
        if char in "^$":
            if (char == "^" and index != 0) or (char == "$" and index != len(pattern) - 1):
                raise ContractError("UNSUPPORTED_REGEX", context)
            atom = False
        elif char == "[":
            end = pattern.find("]", index + 1)
            body = pattern[index + 1 : end]
            if end == -1 or body in ("", "^") or "[" in body or "\\" in body:
                raise ContractError("UNSUPPORTED_REGEX", context)
            index = end
            atom = True
        elif char == "\\":
            index += 1
            if index >= len(pattern) or pattern[index] not in r"\.[]{}()*+?^$|":
                raise ContractError("UNSUPPORTED_REGEX", context)
            atom = True
        elif char in "?*+{":
            if not atom:
                raise ContractError("UNSUPPORTED_REGEX", context)
            if char == "{":
                bound = re.match(r"\{([0-9]+)(?:,([0-9]*))?\}", pattern[index:])
                if bound is None:
                    raise ContractError("UNSUPPORTED_REGEX", context)
                lower, upper = bound.groups()
                if int(lower) > LIMITS.string or (
                    upper not in (None, "") and not int(lower) <= int(upper) <= LIMITS.string
                ):
                    raise ContractError("UNSUPPORTED_REGEX", context)
                variable += int(upper is not None and upper != lower)
                index += len(bound.group()) - 1
            else:
                variable += 1
            if variable > 1:
                raise ContractError("UNSUPPORTED_REGEX", context)
            atom = False
        else:
            if char in "().|]}":
                raise ContractError("UNSUPPORTED_REGEX", context)
            atom = True
        index += 1
    try:
        re.compile(pattern)
    except re.error:
        raise ContractError("UNSUPPORTED_REGEX", context) from None


def inspect_schema(schema: JsonValue, context: ErrorContext) -> None:
    """Bound schema work and reject unsupported assertions instead of ignoring them."""
    count = 0
    refs = 0

    def visit(node: JsonValue, base: str) -> None:
        nonlocal count, refs
        count += 1
        if count > LIMITS.schemas:
            raise ContractError("RESOURCE_LIMIT", context)
        if type(node) is bool:
            return
        if not isinstance(node, dict):
            raise ContractError("SCHEMA_INVALID", context)
        if "$schema" in node and node["$schema"] != JSON_SCHEMA_DIALECT:
            raise ContractError("UNSUPPORTED_DIALECT", context)
        if "$id" in node:
            identifier = node["$id"]
            if not isinstance(identifier, str) or re.search(r"\s|%(?![0-9A-Fa-f]{2})", identifier):
                raise ContractError("SCHEMA_INVALID", context)
            base = urljoin(base, identifier)
        if "$vocabulary" in node:
            vocab = node["$vocabulary"]
            if not isinstance(vocab, dict):
                raise ContractError("SCHEMA_INVALID", context)
            for uri, required in vocab.items():
                if type(required) is not bool or not absolute_uri(uri):
                    raise ContractError("SCHEMA_INVALID", context)
                if (uri in VOCABULARIES and not required) or (uri not in VOCABULARIES and required):
                    raise ContractError("UNSUPPORTED_VOCABULARY", context)
        for key, value in node.items():
            if key not in KEYWORDS:
                raise ContractError("UNSUPPORTED_KEYWORD", context)
            if key == "pattern" and isinstance(value, str):
                check_pattern(value, context)
            if key == "multipleOf" and (
                type(value) not in (int, float)
                or isinstance(value, bool)
                or not isinstance(value, (int, float))
                or value <= 0
                or value % 1 != 0
            ):
                raise ContractError("UNSUPPORTED_NUMBER", context)
            if key in ("$ref", "$dynamicRef"):
                refs += 1
                if refs > LIMITS.references:
                    raise ContractError("RESOURCE_LIMIT", context)
                if key == "$dynamicRef" and isinstance(value, str) and not value.startswith("#"):
                    raise ContractError("SCHEMA_UNAVAILABLE", context)
                if node is schema and value == "#" and all(name.startswith("$") for name in node):
                    raise ContractError("SCHEMA_INVALID", context)
            if key in MAP_SCHEMAS:
                if not isinstance(value, dict):
                    raise ContractError("SCHEMA_INVALID", context)
                if key in ("properties", "patternProperties") and "__proto__" in value:
                    raise ContractError("UNSUPPORTED_KEYWORD", context)
                for name, child in value.items():
                    if key == "patternProperties":
                        check_pattern(name, context)
                    visit(child, base)
            elif key in ONE_SCHEMA:
                visit(value, base)
            elif key in ARRAY_SCHEMAS:
                if not isinstance(value, list):
                    raise ContractError("SCHEMA_INVALID", context)
                for child in value:
                    visit(child, base)

    visit(schema, "")
