"""Hard deadlines and physical process cleanup on every lifecycle outcome."""

import asyncio
from dataclasses import FrozenInstanceError
from pathlib import Path
from typing import cast

import pytest

from a2a_schema_contract.catalog import parse_catalog
from a2a_schema_contract.core import ContractError, ErrorContext, JsonValue
from a2a_schema_contract.operations import Diagnostic, ValidationOptions, ValidationSession, process
from a2a_schema_contract.operations.program import load_selection

from .inline_support import ID, as_dict, catalog
from .test_binding_events import request


def track_spawns(
    monkeypatch: pytest.MonkeyPatch, *, count: int = 1, ready: asyncio.Event | None = None
) -> list[asyncio.subprocess.Process]:
    original = asyncio.create_subprocess_exec
    processes: list[asyncio.subprocess.Process] = []

    async def tracked(*args: str, **kwargs: object) -> asyncio.subprocess.Process:
        child = await original(*args, **kwargs)  # type: ignore[arg-type]
        processes.append(child)
        if ready is not None and len(processes) == count:
            ready.set()
        return child

    monkeypatch.setattr(asyncio, "create_subprocess_exec", tracked)
    return processes


@pytest.mark.asyncio
async def test_request_job_isolated_and_sanitized_hook() -> None:
    parsed = parse_catalog(catalog())
    events: list[Diagnostic] = []

    def observer(event: Diagnostic) -> None:
        events.append(event)
        raise RuntimeError("host telemetry failure with secret")

    async with ValidationSession(parsed, diagnostics=observer) as session:
        packet = await session.run("request", {"request": request()})
        selection = load_selection(parsed, cast("dict[str, JsonValue]", packet))
        assert selection.input.present and selection.input.value == {}
        with pytest.raises(ContractError) as captured:
            await session.run("request", {"request": {"secret": "credential"}})
    assert len(events) == 2
    assert events[0].outcome == "accepted" and events[1].outcome == "rejected"
    assert events[0].correlation_id != events[1].correlation_id
    assert events[0].duration_ms > 0
    assert "credential" not in repr(events) and "secret" not in str(captured.value)
    with pytest.raises(FrozenInstanceError):
        events[0].operation = "other"  # type: ignore[misc]


@pytest.mark.asyncio
async def test_real_exponential_schema_deadline_does_not_block_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    processes = track_spawns(monkeypatch)
    definitions: dict[str, JsonValue] = {
        f"r{i}": {"allOf": [{"$ref": f"#/$defs/r{i + 1}"}, {"$ref": f"#/$defs/r{i + 1}"}]}
        for i in range(25)
    }
    definitions["r25"] = True
    raw = catalog()
    representation = as_dict(as_dict(as_dict(raw["contracts"][0])["input"])["representations"][0])  # type: ignore[index]
    as_dict(representation["schema"])["inline"] = {"$ref": "#/$defs/r0", "$defs": definitions}
    parsed = parse_catalog(raw)
    # Encode the original carrier without using the trusted synchronous helper.
    wire = request()
    ticks = 0
    running = True

    async def ticker() -> None:
        nonlocal ticks
        while running:
            ticks += 1
            await asyncio.sleep(0.005)

    tick = asyncio.create_task(ticker())
    try:
        async with ValidationSession(parsed, options=ValidationOptions(deadline=0.4)) as session:
            with pytest.raises(ContractError, match="VALIDATION_TIMEOUT"):
                await session.run("request", {"request": wire})
            assert not session._jobs
    finally:
        running = False
        await tick
    assert ticks >= 5
    assert processes and all(child.returncode is not None for child in processes)


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["cancel", "close", "deadline", "success", "failure"])
async def test_every_process_reaped_before_return(
    monkeypatch: pytest.MonkeyPatch, action: str
) -> None:
    ready = asyncio.Event()
    processes = track_spawns(monkeypatch, ready=ready)
    if action in ("cancel", "close", "deadline"):
        monkeypatch.setattr(process, "bootstrap", lambda: "import time; time.sleep(20)")
    session = ValidationSession(
        parse_catalog(catalog()),
        options=ValidationOptions(deadline=0.08 if action == "deadline" else 2),
    )
    job = asyncio.create_task(
        session.run("request", {"request": request() if action != "failure" else {}})
    )
    if action in ("cancel", "close"):
        await ready.wait()
        if action == "cancel":
            job.cancel()
        else:
            await session.close()
        with pytest.raises(asyncio.CancelledError):
            await job
    elif action == "deadline":
        with pytest.raises(ContractError, match="VALIDATION_TIMEOUT"):
            await job
    elif action == "failure":
        with pytest.raises(ContractError):
            await job
    else:
        assert await job
    assert processes and all(child.returncode is not None for child in processes)
    assert not session._jobs
    await session.close()


@pytest.mark.asyncio
async def test_cancellation_while_acquiring_process_cannot_lose_handle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = asyncio.create_subprocess_exec
    created = asyncio.Event()
    release = asyncio.Event()
    children: list[asyncio.subprocess.Process] = []

    async def delayed(*args: str, **kwargs: object) -> asyncio.subprocess.Process:
        child = await original(*args, **kwargs)  # type: ignore[arg-type]
        children.append(child)
        created.set()
        await release.wait()
        return child

    monkeypatch.setattr(asyncio, "create_subprocess_exec", delayed)
    monkeypatch.setattr(process, "bootstrap", lambda: "import time; time.sleep(20)")
    session = ValidationSession()
    job = asyncio.create_task(session.run("compile", {}))
    await created.wait()
    job.cancel()
    await asyncio.sleep(0)
    job.cancel()  # repeated cancellation must not cancel the owned acquisition task
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await job
    assert children[0].returncode is not None
    await session.close()


@pytest.mark.asyncio
async def test_capacity_refuses_without_queue_and_close_cancels_all(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ready = asyncio.Event()
    processes = track_spawns(monkeypatch, count=2, ready=ready)
    monkeypatch.setattr(process, "bootstrap", lambda: "import time; time.sleep(20)")
    async with ValidationSession(options=ValidationOptions(concurrent=2)) as session:
        jobs = [asyncio.create_task(session.run("compile", {})) for _ in range(2)]
        await ready.wait()
        with pytest.raises(ContractError, match="RESOURCE_LIMIT"):
            await session.run("compile", {})
        assert len(processes) == 2
        await session.close()
        results = await asyncio.gather(*jobs, return_exceptions=True)
        assert all(isinstance(result, asyncio.CancelledError) for result in results)
        assert all(child.returncode is not None for child in processes)
        with pytest.raises(ContractError, match="VALIDATION_ABORTED"):
            await session.run("compile", {})


@pytest.mark.asyncio
async def test_environment_flags_cwd_and_sitecustomize_not_inherited(
    monkeypatch: pytest.MonkeyPatch, tmp_path: "Path"
) -> None:
    monkeypatch.setenv("A2A_PRIVATE_TEST_SECRET", "must-not-inherit")
    monkeypatch.setenv("PYTHONPATH", str(tmp_path))
    monkeypatch.setenv("PYTHONINSPECT", "1")
    monkeypatch.chdir(tmp_path)
    original = process.bootstrap()
    prefix = original[: original.index("from a2a_schema_contract.operations.worker")]
    monkeypatch.setattr(
        process,
        "bootstrap",
        lambda: (
            prefix + 'import os,sys,json; print(json.dumps({"value": {"secret": '
            'os.getenv("A2A_PRIVATE_TEST_SECRET"), '
            '"isolated": sys.flags.isolated, "noSite": sys.flags.no_site, "path": sys.path}}))'
        ),
    )
    async with ValidationSession() as session:
        result = cast("dict[str, JsonValue]", await session.run("compile", {}))
    assert result["secret"] is None and result["isolated"] == result["noSite"] == 1
    assert str(tmp_path) not in result["path"]  # type: ignore[operator]
    assert "A2A_PRIVATE_TEST_SECRET" not in process.environment()


@pytest.mark.asyncio
@pytest.mark.parametrize("output", ['{"code":"secret cause"}', "not JSON", '{"value":null}'])
async def test_ipc_failures_sanitized_and_success_none(
    monkeypatch: pytest.MonkeyPatch, output: str
) -> None:
    monkeypatch.setattr(process, "bootstrap", lambda: "print(" + repr(output) + ")")
    async with ValidationSession() as session:
        if output == '{"value":null}':
            assert await session.run("compile", {}) is None
        else:
            with pytest.raises(ContractError, match="SCHEMA_INVALID"):
                await session.run("compile", {})


@pytest.mark.asyncio
async def test_compile_error_context_preserved() -> None:
    context = ErrorContext("remote", ID, "input", "json")
    async with ValidationSession() as session:
        with pytest.raises(ContractError) as captured:
            await session.run(
                "compile",
                {
                    "entry": "urn:test:1",
                    "documents": [{"uri": "urn:test:1", "value": {"type": "unknown"}}],
                },
                context=context,
            )
    assert captured.value.origin == "remote" and captured.value.detail is not None
    assert captured.value.detail.contract_id == ID


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "value,accepted",
    [
        ({"count": 0}, True),
        ({"count": 2}, True),
        ({"count": 100}, True),
        ({"count": -1}, False),
        ({"count": 101}, False),
        ({"count": True}, False),
        ({"count": 1.5}, False),
        ({"count": "2"}, False),
        ({"count": None}, False),
        ({}, False),
        ({"count": 2, "extra": True}, False),
    ],
)
async def test_node_benchmark_semantic_decisions(value: JsonValue, accepted: bool) -> None:
    schema: JsonValue = {
        "type": "object",
        "required": ["count"],
        "additionalProperties": False,
        "properties": {"count": {"type": "integer", "minimum": 0, "maximum": 100}},
    }
    parsed = parse_catalog(catalog(schema=schema))
    async with ValidationSession(parsed) as session:
        arguments: dict[str, JsonValue] = {
            "contractId": ID,
            "direction": "input",
            "representationId": "json",
            "value": value,
        }
        if accepted:
            assert await session.run("validate", arguments) == value
        else:
            with pytest.raises(ContractError, match="INSTANCE_INVALID"):
                await session.run("validate", arguments)
