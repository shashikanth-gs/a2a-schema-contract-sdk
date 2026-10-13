"""Exact supported media semantics; no wildcard, suffix, or encoding inference."""

import re
from typing import Literal

from .errors import LOCAL_CONTEXT, ContractError, ErrorContext


def media(value: str, context: ErrorContext = LOCAL_CONTEXT) -> Literal["json", "text"]:
    if "\r" in value or "\n" in value:
        raise ContractError("UNSUPPORTED_MEDIA_TYPE", context)
    if re.fullmatch(r"application/json", value, re.IGNORECASE):
        return "json"
    if re.fullmatch(r'text/plain(?:\s*;\s*charset=(?:utf-8|"utf-8"))?', value, re.IGNORECASE):
        return "text"
    raise ContractError("UNSUPPORTED_MEDIA_TYPE", context)


def match_media_types(first: str, second: str) -> bool:
    try:
        return media(first) == media(second)
    except ContractError:
        return False
