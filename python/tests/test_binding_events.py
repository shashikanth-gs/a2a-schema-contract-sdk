"""Protocol boundary conformance and whole-result publication invariants."""

from collections.abc import Callable
from typing import Literal, cast

import pytest

from a2a_schema_contract.binding import (
    consume_result,
    guard_container,
    guard_request,
    select_request,
)
from a2a_schema_contract.catalog import ContractCatalog, parse_catalog
from a2a_schema_contract.core import EXTENSION_URI, ContractError, JsonValue
from a2a_schema_contract.events import validate_events
from a2a_schema_contract.payload import encode_primary, validate_result

from .inline_support import ID, as_dict, catalog
from .test_inline_peers import final_task


def request(parsed: ContractCatalog | None = None) -> dict[str, JsonValue]:
    actual = parsed if parsed is not None else parse_catalog(catalog())
    return {
        "message": {
            "messageId": "request",
            "role": "ROLE_USER",
            "parts": [
                encode_primary(actual.select(ID, "input", "json"), {}),
            ],
        },
        "metadata": {
            EXTENSION_URI: {
                "contractId": ID,
                "inputRepresentationId": "json",
                "acceptedOutputRepresentationIds": ["json"],
            }
        },
    }


@pytest.mark.parametrize(
    "value",
    [
        None,
        [],
        {},
        {"message": None},
        {"message": {}},
        {"message": {"messageId": "r", "role": "ROLE_AGENT", "parts": [{"text": ""}]}},
        {"message": {"messageId": "r", "role": "ROLE_USER", "parts": []}},
    ],
)
def test_request_shapes_rejected(value: object) -> None:
    with pytest.raises(ContractError):
        guard_request(value)


@pytest.mark.parametrize(
    "mutation",
    [
        "metadata",
        "tenant",
        "config",
        "unknown-config",
        "return-immediate",
        "history",
        "history-fraction",
        "modes",
        "mode-type",
        "message-selection",
        "media-negotiation",
    ],
)
def test_request_configuration_and_binding_rejected(mutation: str) -> None:
    value = request()
    if mutation == "metadata":
        value["metadata"] = None
    elif mutation == "tenant":
        value["tenant"] = None
    elif mutation == "config":
        value["configuration"] = []
    elif mutation == "unknown-config":
        value["configuration"] = {"extra": True}
    elif mutation == "return-immediate":
        value["configuration"] = {"returnImmediately": "true"}
    elif mutation == "history":
        value["configuration"] = {"historyLength": -1}
    elif mutation == "history-fraction":
        value["configuration"] = {"historyLength": 1.5}
    elif mutation == "modes":
        value["configuration"] = {"acceptedOutputModes": None}
    elif mutation == "mode-type":
        value["configuration"] = {"acceptedOutputModes": [1]}
    elif mutation == "message-selection":
        as_dict(value["message"])["metadata"] = value["metadata"]
    else:
        value["configuration"] = {"acceptedOutputModes": ["text/plain"]}
    with pytest.raises(ContractError):
        select_request(parse_catalog(catalog()), value)


@pytest.mark.parametrize(
    "value",
    [
        None,
        {"id": 1},
        {"metadata": []},
        {"parts": []},
        {"artifacts": None},
        {"artifacts": [None]},
        {"artifacts": [{"artifactId": "a", "parts": [{"text": ""}], "name": None}]},
        {"status": None},
        {"status": {"state": []}},
        {"status": {"state": "UNKNOWN"}},
        {"history": None},
        {"history": [None]},
    ],
)
def test_container_original_values_rejected(value: object) -> None:
    with pytest.raises(ContractError):
        guard_container(value)


def candidates() -> list[dict[str, JsonValue]]:
    task = final_task({})
    return [
        {
            "kind": "task",
            "data": {
                "id": "task",
                "contextId": "context",
                "status": {"state": "TASK_STATE_WORKING"},
            },
        },
        {
            "kind": "artifact",
            "data": {
                "taskId": "task",
                "contextId": "context",
                "artifact": cast("list[JsonValue]", task["artifacts"])[0],
                "lastChunk": True,
            },
        },
        {
            "kind": "status",
            "data": {"taskId": "task", "contextId": "context", "status": task["status"]},
        },
    ]


@pytest.mark.parametrize(
    "mutation",
    [
        "empty",
        "not-list",
        "unknown-event",
        "first-status",
        "task-id",
        "context-id",
        "no-status",
        "late",
        "identity",
        "append",
        "last-chunk",
        "duplicate-artifact",
        "artifact-invalid",
        "no-final",
        "failed-primary",
        "input-required-primary",
        "echo-conflict",
        "artifact-echo",
        "status-primary",
    ],
)
def test_atomic_event_sequences_reject(mutation: str) -> None:
    events: object = candidates()
    raw = cast("list[dict[str, JsonValue]]", events)
    first = as_dict(raw[0]["data"])
    update = as_dict(raw[1]["data"])
    final = as_dict(raw[-1]["data"])
    if mutation == "empty":
        events = []
    elif mutation == "not-list":
        events = {}
    elif mutation == "unknown-event":
        raw[0]["extra"] = True
    elif mutation == "first-status":
        raw.pop(0)
    elif mutation == "task-id":
        first["id"] = "foreign"
    elif mutation == "context-id":
        first["contextId"] = "foreign"
    elif mutation == "no-status":
        del first["status"]
    elif mutation == "late":
        raw.append(raw[-1])
    elif mutation == "identity":
        update["contextId"] = "foreign"
    elif mutation == "append":
        update["append"] = True
    elif mutation == "last-chunk":
        update["lastChunk"] = False
    elif mutation == "duplicate-artifact":
        raw.insert(2, raw[1])
    elif mutation == "artifact-invalid":
        update["artifact"] = None
    elif mutation == "no-final":
        raw.pop()
    elif mutation in ("failed-primary", "input-required-primary"):
        as_dict(final["status"])["state"] = (
            "TASK_STATE_FAILED" if mutation == "failed-primary" else "TASK_STATE_INPUT_REQUIRED"
        )
    elif mutation == "echo-conflict":
        final["metadata"] = {EXTENSION_URI: {"contractId": "urn:wrong:1"}}
    elif mutation == "artifact-echo":
        as_dict(update["artifact"])["metadata"] = {EXTENSION_URI: {"contractId": "urn:wrong:1"}}
    else:
        as_dict(final["status"])["message"] = {
            "messageId": "s",
            "role": "ROLE_AGENT",
            "parts": as_dict(update["artifact"])["parts"],
        }
    parsed = parse_catalog(catalog())
    with pytest.raises(ContractError):
        validate_events(parsed, select_request(parsed, request()), events, "task", "context")


def test_approved_events_have_detached_echo_and_ordinary_boundary() -> None:
    parsed = parse_catalog(catalog())
    original = candidates()
    approved = validate_events(
        parsed, select_request(parsed, request()), original, "task", "context"
    )
    assert "metadata" not in as_dict(original[-1]["data"])
    assert as_dict(as_dict(approved[-1]["data"])["metadata"])[EXTENSION_URI] == {
        "contractId": ID,
        "outputRepresentationId": "json",
    }
    assert validate_events(parsed, None, original, "task", "context")[-1] == original[-1]
    value = request()
    value["configuration"] = {"historyLength": 1.0}
    assert guard_request(value) == value


@pytest.mark.parametrize(
    "mutation", ["valid", "wrong-role", "wrong-context", "wrong-task", "two-messages"]
)
def test_standalone_message_contract(mutation: str) -> None:
    parsed = parse_catalog(catalog())
    selection = select_request(parsed, request())
    task = final_task({})
    message: dict[str, JsonValue] = {
        "messageId": "m",
        "role": "ROLE_AGENT",
        "contextId": "context",
        "taskId": "task",
        "parts": as_dict(cast("list[JsonValue]", task["artifacts"])[0])["parts"],
        "metadata": task["metadata"],
    }
    events = [{"kind": "message", "data": message}]
    if mutation == "wrong-role":
        message["role"] = "ROLE_USER"
    elif mutation == "wrong-context":
        message["contextId"] = "other"
    elif mutation == "wrong-task":
        message["taskId"] = "other"
    elif mutation == "two-messages":
        events.append(events[0])
    if mutation == "valid":
        assert validate_events(parsed, selection, events, "task", "context")
        assert validate_events(parsed, None, events, "task", "context")
    else:
        with pytest.raises(ContractError):
            validate_events(parsed, selection, events, "task", "context")


@pytest.mark.parametrize(
    "state",
    [
        "TASK_STATE_INPUT_REQUIRED",
        "TASK_STATE_FAILED",
        "TASK_STATE_CANCELED",
        "TASK_STATE_REJECTED",
    ],
)
def test_noncompleted_tasks_have_no_primary(state: str) -> None:
    parsed = parse_catalog(catalog())
    selection = select_request(parsed, request())
    event = {
        "kind": "task",
        "data": {"id": "task", "contextId": "context", "status": {"state": state}},
    }
    approved = validate_events(parsed, selection, [event], "task", "context")
    assert consume_result(parsed, selection, approved[0]["data"]) is None


def test_optional_absence_and_no_output_message_rejected() -> None:
    parsed = parse_catalog(catalog("required", "optional"))
    selection = select_request(parsed, request(parsed))
    original = [
        {
            "kind": "task",
            "data": {
                "id": "task",
                "contextId": "context",
                "status": {"state": "TASK_STATE_COMPLETED"},
            },
        }
    ]
    approved = validate_events(parsed, selection, original, "task", "context")
    payload = consume_result(parsed, selection, approved[0]["data"])
    assert payload is not None and not payload.present
    none = parse_catalog(catalog("required", "none"))
    raw = request()
    del as_dict(as_dict(raw["metadata"])[EXTENSION_URI])["acceptedOutputRepresentationIds"]
    with pytest.raises(ContractError):
        consume_result(
            none,
            select_request(none, raw),
            {
                "messageId": "m",
                "role": "ROLE_AGENT",
                "parts": [{"text": ""}],
                "metadata": {EXTENSION_URI: {"contractId": ID}},
            },
        )
    with pytest.raises(ContractError):
        validate_result(parsed, ID, {EXTENSION_URI: {"contractId": "urn:wrong:1"}}, [])


def test_lookup_direction_errors_are_explicit() -> None:
    parsed = parse_catalog(catalog())
    for identifier, code in [
        ("bad", "INVALID_IDENTIFIER"),
        ("urn:example:missing:1", "CONTRACT_NOT_FOUND"),
    ]:
        with pytest.raises(ContractError, match=code):
            parsed.get_contract(identifier)
    operations: list[Callable[[], object]] = [
        lambda: parsed.select(ID, cast("Literal['input']", "bad"), "json"),
        lambda: parsed.capabilities(ID, cast("Literal['input']", "bad")),
    ]
    for operation in operations:
        with pytest.raises(ContractError, match="INVALID_STRUCTURE"):
            operation()
    with pytest.raises(ContractError, match="REPRESENTATION_NOT_SUPPORTED"):
        parsed.select(ID, "input", "absent")
