"""Strict JSON boundaries: no duck typing, coercion, callbacks, or caller mutation."""

import json
import math
import re
from typing import cast
from urllib.parse import urlsplit

from .errors import LOCAL_CONTEXT, ContractError, ErrorContext
from .types import LIMITS, JsonValue, Limits


def snapshot(
    value: object,
    context: ErrorContext = LOCAL_CONTEXT,
    *,
    limits: Limits = LIMITS,
) -> JsonValue:
    """Return detached exact builtins; refuse subclass conversion hooks and cycles."""
    nodes = 0
    byte_count = 0
    ancestors: set[int] = set()

    def string(text: str) -> str:
        nonlocal byte_count
        if len(text) > limits.string:
            raise ContractError("RESOURCE_LIMIT", context)
        try:
            text.encode("utf-8", "strict")
        except UnicodeEncodeError:
            raise ContractError("NON_JSON_VALUE", context) from None
        byte_count += len(json.dumps(text, ensure_ascii=False).encode("utf-8"))
        return text

    def visit(item: object, depth: int) -> JsonValue:
        nonlocal nodes, byte_count
        nodes += 1
        byte_count += 8
        if depth > limits.depth or nodes > limits.nodes or byte_count > limits.bytes:
            raise ContractError("RESOURCE_LIMIT", context)
        if item is None or type(item) is bool:
            return item
        if type(item) is str:
            return string(item)
        if type(item) in (int, float):
            number = cast("int | float", item)
            valid = (
                abs(number) <= 9007199254740991
                if type(number) is int
                else math.isfinite(number)
                and (not float(number).is_integer() or abs(number) <= 9007199254740991)
            )
            if not valid:
                raise ContractError("UNSUPPORTED_NUMBER", context)
            byte_count += len(json.dumps(number))
            return number
        if type(item) not in (list, dict) or id(item) in ancestors:
            raise ContractError("NON_JSON_VALUE", context)
        ancestors.add(id(item))
        if type(item) is list:
            sequence = cast("list[object]", item)
            if len(sequence) > limits.nodes:
                raise ContractError("RESOURCE_LIMIT", context)
            result: JsonValue = [visit(child, depth + 1) for child in sequence]
        else:
            mapping = cast("dict[object, object]", item)
            if len(mapping) > limits.nodes:
                raise ContractError("RESOURCE_LIMIT", context)
            result = {}
            for key, child in mapping.items():
                if type(key) is not str:
                    raise ContractError("NON_JSON_VALUE", context)
                result[string(key)] = visit(child, depth + 1)
        ancestors.remove(id(item))
        return result

    result = visit(value, 0)
    if byte_count > limits.bytes:
        raise ContractError("RESOURCE_LIMIT", context)
    return result


def loads(value: str | bytes, context: ErrorContext = LOCAL_CONTEXT) -> JsonValue:
    """Reject duplicate JSON keys and nonfinite numbers before schema validation."""

    def pairs(items: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, child in items:
            if key in result:
                raise ContractError("INVALID_STRUCTURE", context)
            result[key] = child
        return result

    if len(value) > LIMITS.bytes:
        raise ContractError("RESOURCE_LIMIT", context)
    try:
        decoded: object = json.loads(value, object_pairs_hook=pairs)
    except (ValueError, UnicodeError, RecursionError):
        raise ContractError("INVALID_STRUCTURE", context) from None
    return snapshot(decoded, context)


def absolute_uri(value: str) -> bool:
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9+.-]*:[!-~]+", value):
        return False
    if re.search(r"%(?![0-9A-Fa-f]{2})", value):
        return False
    try:
        parsed = urlsplit(value)
        return parsed.username is None and parsed.password is None
    except ValueError:
        return False


def versioned_id(value: str) -> bool:
    return (
        absolute_uri(value)
        and not re.search(r"(?:^|[/:#?=&])latest(?:$|[/:#?=&])", value, re.IGNORECASE)
        and re.search(r"[/:#]v?[0-9]+(?:\.[0-9]+)*(?:-[A-Za-z0-9.-]+)?(?:$|[/:#])", value)
        is not None
    )
