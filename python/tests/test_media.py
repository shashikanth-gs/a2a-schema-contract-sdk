"""Both languages negotiate the same narrow media profile."""

import pytest

from a2a_schema_contract.core import ContractError
from a2a_schema_contract.core.media import match_media_types, media


@pytest.mark.parametrize("value", ["application/json", "APPLICATION/JSON"])
def test_json_media(value: str) -> None:
    assert media(value) == "json"


@pytest.mark.parametrize(
    "value",
    [
        "text/plain",
        "TEXT/PLAIN",
        "text/plain; charset=utf-8",
        'text/plain; charset="UTF-8"',
    ],
)
def test_text_media(value: str) -> None:
    assert media(value) == "text"


@pytest.mark.parametrize(
    "value",
    [
        "application/json; charset=utf-8",
        "application/vendor+json",
        "text/plain; charset=ascii",
        "text/plain; q=1",
        "text/plain\n",
        "text/plain\r",
        "*/*",
    ],
)
def test_unsupported_media(value: str) -> None:
    with pytest.raises(ContractError, match="UNSUPPORTED_MEDIA_TYPE"):
        media(value)


def test_matching_modes() -> None:
    assert match_media_types("text/plain", "TEXT/PLAIN; charset=utf-8")
    assert not match_media_types("text/plain", "application/json")
    assert not match_media_types("text/plain", "*/*")
