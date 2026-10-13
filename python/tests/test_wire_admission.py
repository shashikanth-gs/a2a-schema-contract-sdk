"""Original wire scalar, oneof, timestamp, map and UTF-8 admission regressions."""

import pytest
from a2a.types import AgentCard, Part, SendMessageRequest, Task

from a2a_schema_contract.adapters.wire import admit
from a2a_schema_contract.core import ContractError, loads


@pytest.mark.parametrize(
    "value",
    [
        None,
        [],
        {"text": "", "data": None},
        {"text": "", "filename": None},
        {"raw": "YR=="},
        {"raw": "é"},
    ],
)
def test_part_admission_does_not_normalize(value: object) -> None:
    with pytest.raises(ContractError):
        admit(value, Part)


@pytest.mark.parametrize("value", [None, 1, "not-a-time", "2026-13-99T99:00:00Z"])
def test_timestamp_original_values(value: object) -> None:
    with pytest.raises(ContractError):
        admit({"status": {"state": "TASK_STATE_COMPLETED", "timestamp": value}}, Task)


def test_valid_timestamps_and_original_scalar_fields() -> None:
    assert admit(
        {"status": {"state": "TASK_STATE_COMPLETED", "timestamp": "2026-10-14T00:00:00Z"}}, Task
    )
    assert admit({"raw": "YQ=="}, Part) == {"raw": "YQ=="}
    assert admit({"securitySchemes": {"test": {}}}, AgentCard)


@pytest.mark.parametrize("value", [None, [], {"test": None}, {"test": {"unknown": True}}])
def test_advertisement_map_fields(value: object) -> None:
    with pytest.raises(ContractError):
        admit({"securitySchemes": value}, AgentCard)


@pytest.mark.parametrize("value", [None, "1", True, 1.5, 2147483648])
def test_proto_integer_boundaries(value: object) -> None:
    with pytest.raises(ContractError):
        admit({"configuration": {"historyLength": value}}, SendMessageRequest)


def test_integral_float_preserved_without_sdk_coercion() -> None:
    assert admit({"configuration": {"historyLength": 1.0}}, SendMessageRequest) == {
        "configuration": {"historyLength": 1.0}
    }


@pytest.mark.parametrize("body", [b"\xff", "{}".encode("utf-16"), b"\xef\xbb\xbf{}"])
def test_network_json_is_strict_utf8(body: bytes) -> None:
    with pytest.raises(ContractError, match="INVALID_STRUCTURE"):
        loads(body)


def test_valid_utf8_network_json() -> None:
    assert loads('{"label":"café"}'.encode()) == {"label": "café"}
