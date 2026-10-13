"""Atomic publication policy for complete, bounded candidate event sequences."""

from typing import cast

from .binding import (
    STOP_STATES,
    ContractSelection,
    check_echo,
    consume_result,
    echo,
    guard_artifact,
    guard_container,
    is_primary,
    reject,
)
from .catalog import ContractCatalog
from .core import EXTENSION_URI, JsonValue, snapshot


def validate_events(
    catalog: ContractCatalog,
    selection: ContractSelection | None,
    candidates: object,
    task_id: str,
    context_id: str,
    *,
    started: bool = False,
) -> list[dict[str, JsonValue]]:
    copied = snapshot(candidates)
    if not isinstance(copied, list) or not copied:
        reject()
    events = cast("list[dict[str, JsonValue]]", copied)
    if any(not isinstance(item, dict) or set(item) != {"kind", "data"} for item in events):
        reject()
    first = events[0]
    data = guard_container(first["data"])
    if first["kind"] == "message":
        if (
            len(events) != 1
            or data.get("role") != "ROLE_AGENT"
            or data.get("contextId") != context_id
            or data.get("taskId", task_id) != task_id
        ):
            reject()
        if selection is not None:
            consume_result(catalog, selection, data)
        return events
    if first["kind"] != "task" or data.get("id") != task_id or data.get("contextId") != context_id:
        reject()
    if "status" not in data:
        reject()
    task = dict(data)
    metadata = dict(cast("dict[str, JsonValue]", task.get("metadata", {})))
    if started:
        metadata.pop(EXTENSION_URI, None)
    task["metadata"] = metadata
    status = cast("dict[str, JsonValue]", task["status"])
    stopped = status["state"] in STOP_STATES
    artifacts = {
        cast("str", item["artifactId"]): item
        for item in cast("list[dict[str, JsonValue]]", task.get("artifacts", []))
    }
    for event in events[1:]:
        current = guard_container(event["data"])
        if (
            stopped
            or event["kind"] not in ("status", "artifact")
            or current.get("taskId") != task_id
            or current.get("contextId") != context_id
        ):
            reject()
        if event["kind"] == "artifact":
            artifact = guard_artifact(current.get("artifact"))
            identifier = cast("str", artifact["artifactId"])
            if (
                current.get("append", False) is not False
                or current.get("lastChunk") is not True
                or identifier in artifacts
            ):
                reject()
            artifacts[identifier] = artifact
        else:
            if "status" not in current:
                reject()
            status = cast("dict[str, JsonValue]", current["status"])
            task["status"] = status
            metadata.update(cast("dict[str, JsonValue]", current.get("metadata", {})))
            stopped = status["state"] in STOP_STATES
    if not stopped:
        reject()
    task["artifacts"] = list(artifacts.values())
    if selection is None:
        return events
    present = any(
        is_primary(part)
        for artifact in artifacts.values()
        for part in cast("list[JsonValue]", artifact["parts"])
    )
    if status["state"] == "TASK_STATE_INPUT_REQUIRED":
        if present:
            reject()
        association = echo(selection, selection.output is not None)
        check_echo(metadata, association)
        last = cast("dict[str, JsonValue]", events[-1]["data"])
        last["metadata"] = {
            **cast("dict[str, JsonValue]", last.get("metadata", {})),
            EXTENSION_URI: association,
        }
        return events
    if status["state"] != "TASK_STATE_COMPLETED":
        if present:
            reject()
        return events
    result_echo = echo(selection, present)
    for event in events[1 if started else 0 :]:
        check_echo(cast("dict[str, JsonValue]", event["data"]).get("metadata", {}), result_echo)
    check_echo(metadata, result_echo)
    for artifact in artifacts.values():
        check_echo(artifact.get("metadata", {}), result_echo)
    task["metadata"] = {**metadata, EXTENSION_URI: result_echo}
    consume_result(catalog, selection, task)
    last = cast("dict[str, JsonValue]", events[-1]["data"])
    last["metadata"] = {
        **cast("dict[str, JsonValue]", last.get("metadata", {})),
        EXTENSION_URI: result_echo,
    }
    return events
