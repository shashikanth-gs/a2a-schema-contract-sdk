"""A2A 1.0 wire-shape application boundary, independent of SDK model objects."""

from dataclasses import dataclass
from typing import Never, cast

from .catalog import ContractCatalog, PreparedRepresentation
from .core import EXTENSION_URI, LIMITS, ContractError, ErrorContext, JsonValue, snapshot
from .core.media import match_media_types
from .core.models import Invocation, Payload
from .payload import guard_part, validate_invocation, validate_result

STOP_STATES = frozenset(
    {
        "TASK_STATE_COMPLETED",
        "TASK_STATE_FAILED",
        "TASK_STATE_CANCELED",
        "TASK_STATE_REJECTED",
        "TASK_STATE_INPUT_REQUIRED",
    }
)
TASK_STATES = STOP_STATES | {
    "TASK_STATE_SUBMITTED",
    "TASK_STATE_WORKING",
    "TASK_STATE_AUTH_REQUIRED",
}


def reject() -> Never:
    raise ContractError("INVALID_METADATA", ErrorContext("remote"))


def guard_parts(parts: object) -> list[JsonValue]:
    copied = snapshot(parts, ErrorContext("remote"))
    if not isinstance(copied, list) or not copied or len(copied) > LIMITS.parts:
        reject()
    assert isinstance(copied, list)
    for part in copied:
        guard_part(part, ErrorContext("remote"))
    return copied


def guard_container(value: object) -> dict[str, JsonValue]:
    data = snapshot(value, ErrorContext("remote"))
    if not isinstance(data, dict):
        reject()
    assert isinstance(data, dict)
    for field in ("id", "messageId", "taskId", "contextId", "tenant"):
        if field in data and not isinstance(data[field], str):
            reject()
    if "metadata" in data and not isinstance(data["metadata"], dict):
        reject()
    if "parts" in data:
        guard_parts(data["parts"])
        if data.get("role") not in ("ROLE_USER", "ROLE_AGENT") or not data.get("messageId"):
            reject()
    if "artifacts" in data:
        artifacts = data["artifacts"]
        if not isinstance(artifacts, list) or len(artifacts) > LIMITS.parts:
            reject()
        ids: set[str] = set()
        for raw in artifacts:
            artifact = guard_artifact(raw)
            identifier = cast("str", artifact["artifactId"])
            if identifier in ids:
                reject()
            ids.add(identifier)
    if "status" in data:
        status = data["status"]
        if (
            not isinstance(status, dict)
            or not isinstance(status.get("state"), str)
            or status["state"] not in TASK_STATES
        ):
            reject()
        if "message" in status:
            message = guard_container(status["message"])
            if any(is_primary(part) for part in cast("list[JsonValue]", message.get("parts", []))):
                reject()
    if "history" in data:
        history = data["history"]
        if not isinstance(history, list) or len(history) > LIMITS.parts:
            reject()
        for historical in history:
            current = guard_container(historical)
            guard_parts(current.get("parts"))
    return data


def guard_artifact(value: object) -> dict[str, JsonValue]:
    data = snapshot(value, ErrorContext("remote"))
    if (
        not isinstance(data, dict)
        or not isinstance(data.get("artifactId"), str)
        or not data["artifactId"]
    ):
        reject()
    assert isinstance(data, dict)
    guard_parts(data.get("parts"))
    if "metadata" in data and not isinstance(data["metadata"], dict):
        reject()
    for name in ("name", "description"):
        if name in data and not isinstance(data[name], str):
            reject()
    return data


def is_primary(value: JsonValue) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("metadata"), dict)
        and EXTENSION_URI in cast("dict[str, JsonValue]", value["metadata"])
    )


def guard_request(value: object) -> dict[str, JsonValue]:
    data = snapshot(value, ErrorContext("remote"))
    if not isinstance(data, dict):
        reject()
    assert isinstance(data, dict)
    message = guard_container(data.get("message"))
    if message.get("role") != "ROLE_USER" or not message.get("messageId"):
        reject()
    guard_parts(message.get("parts"))
    if "metadata" in data and not isinstance(data["metadata"], dict):
        reject()
    if "tenant" in data and not isinstance(data["tenant"], str):
        reject()
    config = data.get("configuration", {})
    if not isinstance(config, dict):
        reject()
    if config.keys() - {"acceptedOutputModes", "returnImmediately", "historyLength"}:
        reject()
    if "returnImmediately" in config and type(config["returnImmediately"]) is not bool:
        reject()
    if "historyLength" in config and (
        type(config["historyLength"]) not in (int, float)
        or not float(cast("int | float", config["historyLength"])).is_integer()
        or not 0 <= cast("int | float", config["historyLength"]) <= 2147483647
    ):
        reject()
    modes = config.get("acceptedOutputModes", [])
    if not isinstance(modes, list) or any(type(mode) is not str for mode in modes):
        reject()
    return data


@dataclass(frozen=True, slots=True)
class ContractSelection:
    invocation: Invocation
    input: Payload
    output: PreparedRepresentation | None


def select_request(catalog: ContractCatalog, request: object) -> ContractSelection:
    data = guard_request(request)
    message = cast("dict[str, JsonValue]", data["message"])
    config = cast("dict[str, JsonValue]", data.get("configuration", {}))
    metadata = message.get("metadata", {})
    if (isinstance(metadata, dict) and EXTENSION_URI in metadata) or config.get(
        "returnImmediately"
    ):
        reject()
    selection = validate_invocation(catalog, data.get("metadata", {}), message["parts"])
    contract = catalog.get_contract(selection.invocation.contract_id)
    if contract.output.presence == "none":
        return ContractSelection(selection.invocation, selection.input, None)
    ids = selection.invocation.accepted_output_representation_ids
    modes = cast("list[str]", config.get("acceptedOutputModes", []))
    for cap in catalog.capabilities(contract.id, "output"):
        rep = cap.representation
        if (
            cap.supported
            and (ids is None or rep.id in ids)
            and (not modes or any(match_media_types(mode, rep.media_type) for mode in modes))
        ):
            return ContractSelection(
                selection.invocation,
                selection.input,
                catalog.select(contract.id, "output", rep.id, "remote"),
            )
    raise ContractError(
        "REPRESENTATION_NOT_SUPPORTED", ErrorContext("remote", contract.id, "output")
    )


def echo(selection: ContractSelection, present: bool) -> dict[str, JsonValue]:
    data: dict[str, JsonValue] = {"contractId": selection.invocation.contract_id}
    if present:
        if selection.output is None:
            reject()
        assert selection.output is not None
        data["outputRepresentationId"] = selection.output.representation.id
    return data


def check_echo(metadata: object, expected: object) -> None:
    if (
        isinstance(metadata, dict)
        and EXTENSION_URI in metadata
        and metadata[EXTENSION_URI] != expected
    ):
        reject()


def consume_result(
    catalog: ContractCatalog, selection: ContractSelection, response: object
) -> Payload | None:
    data = guard_container(response)
    contract_id = selection.invocation.contract_id
    if "parts" in data:
        if (
            data["role"] != "ROLE_AGENT"
            or catalog.get_contract(contract_id).output.presence == "none"
        ):
            reject()
        return validate_result(
            catalog,
            contract_id,
            data.get("metadata", {}),
            data["parts"],
            selection.output.representation.id if selection.output else None,
        )
    if not data.get("id") or not data.get("contextId") or "status" not in data:
        reject()
    status = cast("dict[str, JsonValue]", data["status"])
    artifacts = cast("list[dict[str, JsonValue]]", data.get("artifacts", []))
    parts = [part for artifact in artifacts for part in cast("list[JsonValue]", artifact["parts"])]
    if status["state"] != "TASK_STATE_COMPLETED":
        if status["state"] not in STOP_STATES or any(is_primary(part) for part in parts):
            reject()
        if status["state"] == "TASK_STATE_INPUT_REQUIRED":
            association = echo(selection, selection.output is not None)
            metadata = data.get("metadata", {})
            check_echo(metadata, association)
            if not isinstance(metadata, dict) or EXTENSION_URI not in metadata:
                reject()
        return None
    for artifact in artifacts:
        check_echo(
            artifact.get("metadata", {}),
            cast("dict[str, JsonValue]", data.get("metadata", {})).get(EXTENSION_URI),
        )
    return validate_result(
        catalog,
        contract_id,
        data.get("metadata", {}),
        parts,
        selection.output.representation.id if selection.output else None,
    )


def check_response(
    catalog: ContractCatalog, selection: ContractSelection, response: object, request: object
) -> Payload | None:
    request = cast("dict[str, JsonValue]", snapshot(request))
    data = guard_container(response)
    message = cast("dict[str, JsonValue]", request["message"])
    if (
        ("contextId" in message and data.get("contextId") != message["contextId"])
        or ("taskId" in message and data.get("taskId", data.get("id")) != message["taskId"])
        or not data.get("contextId")
    ):
        reject()
    metadata = cast("dict[str, JsonValue]", data.get("metadata", {})).get(EXTENSION_URI)
    status = cast("dict[str, JsonValue]", data.get("status", {}))
    if (
        isinstance(metadata, dict)
        and "outputRepresentationId" in metadata
        and (
            "parts" in data
            or status.get("state") in ("TASK_STATE_COMPLETED", "TASK_STATE_INPUT_REQUIRED")
        )
    ):
        identifier = metadata["outputRepresentationId"]
        accepted = selection.invocation.accepted_output_representation_ids
        if not isinstance(identifier, str) or (accepted is not None and identifier not in accepted):
            reject()
        output = catalog.select(selection.invocation.contract_id, "output", identifier, "remote")
        modes = cast("dict[str, JsonValue]", request.get("configuration", {})).get(
            "acceptedOutputModes", []
        )
        if modes and not any(
            match_media_types(mode, output.representation.media_type)
            for mode in cast("list[str]", modes)
        ):
            reject()
        selection = ContractSelection(selection.invocation, selection.input, output)
    payload = consume_result(catalog, selection, data)
    return payload
